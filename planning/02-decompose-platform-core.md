# Plan 02 — Decompose the Platform Core (Worker, Modules, Scheduler, Bus)

Goal: turn the 719-line `apps/worker/src/index.ts` monolith into small, testable services with a
module contract that's *enforced*, not aspirational. This is the heart of the re-architecture.

## Problems being solved

1. **The worker is 5 responsibilities in one file**: module host, cron scheduler, event-trigger
   bridge, job dispatcher, bus archiver, narrative upserter, schema self-healer.
2. **Platform code breaches the module boundary**: `apps/worker/src/index.ts:173-200` runs a raw
   `mod_slack.slack_messages` query inside the narrative upserter — `ARCHITECTURE.md`'s "no
   cross-module DB access" rule is violated by the platform itself.
3. **Hand-rolled cron** (`index.ts:305-346`) silently no-ops on any pattern beyond
   `*` / `*/n` / fixed-minute in the minute field; no TZ support; single-worker only.
4. **Two sources of truth for message history**: JetStream stream `feedeater_bus` *and*
   `bus_messages`, reconciled at boot by a "Startup Re-emit" with its own dedupe table
   (`bus_reemit_dedupe`) — a lot of machinery to fight Postgres instead of trusting it.
5. **module-sdk is types only** (`packages/module-sdk/src/index.ts`): modules receive a raw
   `DbLike`/`NatsLike` bag and hand-roll schemas (`ensureSchema` duplicating `sql/schema.sql`),
   settings fetches, AI calls. Nothing prevents a module from `import`ing another module.

## Decision Points

### D1. Where should durable event state live? — **DECIDED: Postgres outbox + NATS as live signal**
| Option | Notes |
|---|---|
| **Postgres outbox + NATS as live signal only (DECIDED)** | Matches the direction the team was already landing on pre-refactor. Publishers write `bus_messages`/`bus_tags` in a transaction (outbox row or trigger → NATS publish); NATS carries only realtime fan-out, JetStream retained just for job events. Deletes: the archiver, `_tags` consumer, startup re-emit, dedupe table, `xmax=0` dedupe hack in `ingest.ts:472-506`, and the "worker is stateful" anxiety in `agent.md` — Postgres *is* the log, trivially queryable, retention becomes plain SQL. Cost: every publish path must go through a transactional helper. |
| Keep JetStream as log + archiver projection | Rejected: status quo machinery fights Postgres instead of trusting it. |
| NATS KV for dedupe/state | Rejected: a third storage plane. |

### D2. Job scheduling engine — **DECIDED: croner + DB-leased runs**
| Option | Notes |
|---|---|
| **croner + DB-leased runs (DECIDED)** | Replace `nextCronTime` with croner (TZ-aware, full cron syntax, overlap protection); cron tick only *enqueues* into `job_runs` (`status=queued`) — matching today's `/api/jobs/run` path. Claim runs with `SELECT … FOR UPDATE SKIP LOCKED` so multiple workers can scale out safely. Complies with `agent.md` (no Redis/BullMQ, Postgres reconstructs everything). |
| pg-boss | Rejected: same semantics off-the-shelf, but owning the ~200 lines keeps the job model legible and dependency-light. |
| Keep NATS `feedeater.jobs.>` as the queue | Rejected: at-least-once + no leases means double-runs on redelivery; today's dispatcher has no idempotency guard. |

### D3. Module isolation model — **DECIDED: worker-per-module (rip the band-aid off now)**
| Option | Notes |
|---|---|
| **Worker-per-module: one process/container per module (DECIDED)** | True fault isolation from day one — a crashing slack poller can never kill the cron loop. The module SDK becomes *fully remote*: every capability (settings, AI, bus emit/subscribe, unified logs, job status reporting) travels over NATS or internal HTTP, and `db` is a PG role scoped to the module's own schema — the interop contract stops being a lint rule and becomes physics. Costs accepted: compose gains one service per module (profiles), the CI build matrix gains per-module images from a shared module-runner base, and job run reporting becomes an explicit NATS protocol instead of function returns. |
| In-process runtime + capability context | Rejected: was the recommended stepping stone, but the SDK surface is identical either way — going straight to process isolation skips the intermediate state. |
| WASM plugins | Rejected: vLLM/AI + DB calls through WASM host functions is overkill. |

### D4. How narratives learn which messages they own — **DECIDED: message IDs in the event (agent's choice)**
| Option | Notes |
|---|---|
| **Message IDs in the event (DECIDED)** | Extend the `narrativeUpdated` contract (zod, in `packages/core/src/contracts/busEvents.ts`) to carry `messageBusIds: uuid[]`. Platform upserts `bus_narrative_messages` straight from the event; the Slack-specific branch in the worker is deleted entirely. Self-contained events keep the bus-only interop rule intact — no callbacks into modules. |
| Platform "resolver" hook per module | Rejected: keeps events small but adds async coupling between worker and module host — strictly worse with worker-per-module (D3), where it would become a remote procedure call. |

### D5. What is `modules/system`? — **DECIDED: platform config registry**
Stop pretending — extract `modules/system/module.json`'s 26 settings into a first-class
**platform config registry** (`packages/core` schema, owned by `apps/api`), surfaced in the
UI like a module but not loaded as a runtime; move `aiDebug` into a health endpoint.
(Rejected alternative: keep it as a module and give it the full anatomy — it has no runtime
and never will.)

## To-Do

### Split the worker (target layout)
- [ ] `apps/worker/src/index.ts` → thin composition root (~50 lines) wiring:
  - [ ] `scheduler/` — croner-based, enqueue-only (D2)
  - [ ] `jobrunner/` — trigger bridge (`triggeredBy` → JobRun), dispatcher, `job_runs`/`job_states` writer, run lease + heartbeat; receives run status/log/metric events back from module processes over NATS (D3)
  - [ ] `narrative/` — pure projection of `narrativeUpdated` events (D4), **zero module-specific SQL**
  - [ ] `bus/` — outbox publisher (D1): transactional write to `bus_messages`/`bus_tags` → NATS live signal; archiver, `_tags` consumer, startup re-emit, and dedupe machinery all deleted
- [ ] **Module processes (D3)**: `packages/module-sdk` ships the module-runner entrypoint; each module gets `modules/<name>/src/main.ts` (boot SDK → declare jobs → subscribe `feedeater.jobs.<module>.>` → report status/logs/metrics over NATS). One container per module via compose profiles; per-module images from a shared module-runner base extend plan 01 D6's build matrix and plan 04's `docker-compose.prod.yml`
- [ ] Extract the four ad-hoc subscriptions in today's index (`feedeater.jobs.>`,
  `feedeater.*.narrativeUpdated`, `triggeredBy` subjects, JobRun events) into named services with their own tests
- [ ] Fold `ensureNarrativeStorage` (`index.ts:78-121`) into versioned migrations (plan 03); no runtime DDL

### Module SDK (make the contract real)
- [ ] Ship `@feedeater/module-sdk` runtime — **fully remote**, since modules no longer share a
  process with the platform (D3): settings client (encrypted fetch via
  `/api/internal/settings`), bus emit/subscribe helpers using core zod contracts, `narrative.update()`,
  `ai.summary()`, `ai.embed()`, `log.*` (unified log), `db` scoped to own schema
  (PG role `mod_<name>` with `GRANT`s limited to its own schema, so cross-schema writes are
  *impossible*, not discouraged)
- [ ] Define `module.json` schema in `packages/core` (single zod definition used by api discovery,
  module-runner validation, and CI validation of every module); api discovers manifests via a
  shared read-only mount, module processes announce readiness over NATS at boot
- [ ] Add `migrations/` convention for modules (see plan 03); delete duplicated
  `ensureSchema()` vs `sql/schema.sql` in `modules/slack/src/ingest.ts:381-453`
- [ ] Boundary enforcement is now structural (process boundary + PG role); keep a CI lint rule
  against cross-module imports as belt-and-braces
- [ ] Port `modules/slack` against the new SDK; it becomes the reference module (fold `modules/example` into docs or delete)

### Platform config registry (D5)
- [ ] Extract `modules/system/module.json`'s 26 settings into a `packages/core` schema owned by
  `apps/api`, surfaced in the UI like a module but not loaded as a runtime; move `aiDebug` into
  a health endpoint; internal modules/settings endpoints keep working against the registry shape

### Bus & realtime plumbing
- [ ] **DECIDED — Stream Hub + multiplexed SSE (pairs with plan 04):** one shared NATS
  subscription per subject per API *process* (the "Stream Hub"), decode + validate +
  enrich each event once, fan out to local clients of a single `/api/stream?topics=…`
  endpoint. Today every browser tab = one core NATS subscription per feed
  (`apps/api/src/index.ts:57-131`, `logsStream.ts`, `narratives.ts`) *plus* a
  per-message-per-client Postgres lookup for `narrativeSummaryShort` — both multipliers
  die here; enrichment moves to archive-time denormalization (D1) or a hub-side cache
  invalidated by `narrativeUpdated`
- [ ] Standardize subject grammar in `packages/core/src/nats/subjects.ts`; add a
  `feedeater.<module>.messageCreated` version header field to events for forward-compat
- [ ] If D1=outbox: remove JetStream stream `feedeater_bus`, `feedeater_archiver*` consumers,
  `bus_reemit_dedupe`, and the re-emit lookback logic

### Jobs semantics
- [ ] Run lease: `claimedBy`/`heartbeatAt` columns on `job_runs`; orphaned `running` rows
  requeued after timeout (currently a worker crash mid-run leaves the run stuck)
- [ ] Retries/backoff as system settings (settings-over-constants rule); metrics merge
  (`durationMs` + handler metrics) moves into the jobrunner tests

### Definition of done
- [ ] `grep -r "mod_slack" apps/` → no matches (platform is module-agnostic)
- [ ] `wc -l apps/worker/src/*.ts` → no file over ~200 lines
- [ ] Killing a module container mid-job doesn't stop cron ticks; the orphaned run is requeued by the lease logic
- [ ] Two platform workers can run side-by-side with no double-scheduled jobs
