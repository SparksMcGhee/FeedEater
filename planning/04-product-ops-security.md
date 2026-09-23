# Plan 04 — Product Surface, Security & Operations

Goal: a dashboard that feels like the "batteries-included backplane" the README promises,
plus closing the security gap that currently makes this repo dangerous to expose, and a
deploy/backup/testing story that matches `agent.md`'s idempotency promises.

## 🚨 Security (do these regardless of whether the rest of the refactor happens)

1. **There is no authentication.** Every `/api/*` route (settings writes, job triggers,
   message history, narratives) is open to anyone who can reach port 666. The only guards are
   same-origin Caddy and a shared `FEED_INTERNAL_TOKEN` on `/api/internal/*`.
2. **Insecure defaults that fail open**: `docker-compose.yml` ships a placeholder
   `FEED_SETTINGS_KEY` and `FEED_INTERNAL_TOKEN=dev-internal-token`; api/worker fail-fast only
   on *absence*, so the compose defaults satisfy them.
3. Settings encryption key rotation is a cliff: `agent.md` forbids regenerating
   `FEED_SETTINGS_KEY` without wiping the `Setting` table.

### Decision: auth model — **DECIDED: Teleport JWT validation + single-user switch**

The service always sits behind Teleport application brokering, so FeedEater does not
own authentication: it validates Teleport-issued JWTs and derives the **User** from them.

- Teleport app access injects an RS256-signed JWT into every proxied request in the
  `Teleport-Jwt-Assertion` header (a different header can be configured via Teleport's
  `{{internal.jwt}}` header-passthrough rewrite).
- Validate against the cluster JWKS — `https://teleport.sparks.works/.well-known/jwks.json`
  (verified live 2026-09: RS256 keys with `kid`) — using `jose`'s `createRemoteJWKSet`,
  which handles `kid` rotation and caches keys. Check signature, `exp`/`nbf`, and `iss`.
- Identity: the `username`/`sub` claim becomes the User id; carry `roles`/`traits` on the
  request context for future RBAC (e.g. admin-only settings writes) — first pass is
  identity only, all authenticated Users are equal.
- SSE works unchanged: Teleport injects the header at the proxy on *every* request, so
  native `EventSource` on `/api/stream` needs no cookies or token-in-query workarounds.
  Revalidation happens naturally on each EventSource auto-reconnect.
- **Single-user switch** (`FEED_AUTH_MODE=single-user`): skips JWT validation and
  resolves every request to a fixed User (`local`). For development and headless
  operation. Default is `teleport` (fail-closed); boot logs a loud warning when
  single-user mode is active.

Config (env, deployment-level — deliberately *not* DB-backed settings; toggling auth at
runtime would be a security hole, which the settings-over-constants rule is not meant
to permit):

- `FEED_AUTH_MODE`: `teleport` (default) | `single-user`
- `FEED_TELEPORT_PROXY`: Teleport proxy base URL; default `https://teleport.sparks.works`.
  JWKS URL derived as `<proxy>/.well-known/jwks.json`.
- `FEED_TELEPORT_CLUSTER_NAME` (optional, recommended in prod): expected `iss` — the
  JWT's `iss` is the Teleport cluster name, which is not necessarily the proxy hostname.

**Trust boundary (critical):** the assertion header is only trustworthy if Teleport is
the *only* ingress path. Compose must not publish api/web ports to the host/LAN, the
Ansible deploy must assert this invariant, and any Caddy listener not fed by Teleport
must strip `Teleport-Jwt-Assertion` from inbound requests. RSC/route-handler fetches
from web→api must forward the incoming assertion header (or keep all authenticated
fetches client-side, as today).

Rejected alternatives: built-in session cookies (redundant — Teleport already owns
identity + MFA), Caddy `forward_auth` + Authelia/Heimdall (a duplicate IdP stack),
passkeys (can't beat "the broker already did it" for this deployment model).

### To-Do — security
- [ ] Remove secret defaults from `docker-compose.yml`; generate at first boot into `.env` if missing (fail hard, never default)
- [ ] Auth middleware (`apps/api/src/auth/`): `jose` `createRemoteJWKSet` against
  `<FEED_TELEPORT_PROXY>/.well-known/jwks.json`; verify RS256 + `exp`/`nbf` (+ `iss`
  when `FEED_TELEPORT_CLUSTER_NAME` is set); attach `req.user = { id, roles, traits }`;
  401 on missing/invalid token. `FEED_AUTH_MODE=single-user` short-circuits to the
  fixed `local` User; fail-closed default; startup warning log
- [ ] Protect all `/api/*` incl. the multiplexed `/api/stream` (which replaces today's
  three SSE endpoints) and `/api/settings/:module` GET (today "public, secrets nulled" —
  but message content is fully public); `/api/internal/*` stays on `FEED_INTERNAL_TOKEN`
- [ ] Ingress hardening: compose publishes no api/web ports to host/LAN; Ansible asserts
  the Teleport-only path; Caddy strips `Teleport-Jwt-Assertion` on any non-Teleport listener
- [ ] Key rotation without data loss: store settings encrypted under versioned key (`keyring` table: keyId → encrypted FEED_SETTINGS_KEY); re-encrypt on rotation; amends the `agent.md` warning instead of fighting it
- [ ] `FEED_INTERNAL_TOKEN`: per-instance generated, header-compared with `timingSafeEqual`
- [ ] Audit the Slack channel picker (`apps/api/src/slackChannels.ts`) — it decrypts the bot token server-side and proxies `conversations.list`; keep that direction (token never reaches browser) but add auth + rate limit

## Web product surface

### Problems
- Cards are hardcoded: `apps/web/components/ModulePage.tsx:142` special-cases
  `slack`/`slackChannels`; every other module card renders "(This card is not yet wired to a UI widget.)"
- Three independent SSE hooks with hand-rolled reconnect/backoff in each Live*Feed component
- Next 14 pages fetch everything client-side from `/api/*`

### Decision: module UI extensibility
| Option | Notes |
|---|---|
| **Card registry (recommended)** | `module.json` declares card `type` (`table`, `form`, `status`, `list`, `channels-picker`) + config; web ships generic renderers; special cards (Slack picker) become built-in renderer plugins in a `components/cards/registry.ts` map, deleting the if-chain. Modules *cannot* ship JS safely in-process anyway; structured descriptors keep the plugin promise honest. |
| Module-supplied UI bundles (dynamic import of remote components) | True "install anything" UX; real sandboxing/CSRF work required. Defer. |

### To-Do — web
- [ ] Next 16 / React 19 migration (paired with plan 01 D2): RSC for the static page shells (modules index, module pages), client islands only for live feeds
- [ ] **DECIDED — multiplexed stream:** one `/api/stream?topics=bus,logs,narratives`
  SSE endpoint + one `useFeedEaterStream(topics)` hook in a shared client context
  (1 connection per tab, replacing 3 SSE endpoints × N tabs). Server-side Stream Hub
  per plan 02: one NATS subscription per subject per *process*, decode + enrich once,
  fan out to local clients; kill the per-message-per-client Postgres lookups in today's
  bus/narratives streams (denormalize `narrativeSummaryShort` at archive time per plan
  02 D1, or hub-side cache invalidated by `narrativeUpdated`). Filters stay client-side
  and never reconnect the stream — today every keystroke re-opens the EventSource
- [ ] **DECIDED — per-user server-side view prefs:** `user_prefs` table (`user_id`,
  `key`, `value` jsonb, `updated_at`; PK `(user_id, key)`) in `public` + `/api/prefs`
  GET/PUT scoped to `req.user.id`. Client precedence: URL params > user prefs >
  defaults. Migrate the `dashboard_*` keys out of the `system` module settings and
  delete the settings-PUT-per-keystroke path — view state was never module config
- [ ] Card registry refactor removing the Slack if-chain; wire `systemStatus` + `slackStatus` cards through it
- [ ] Virtualize `LiveBusFeed`/`LiveLogsFeed` (dashboard_bus_limit default 200 will grow)
- [ ] Narratives page: show summary version history (`bus_narratives.version` exists, unused in UI) and click-through to linked messages via `bus_narrative_messages`

## Operations & deployment

### Current state
Ansible rsyncs the tree to `djx_spark`, `docker compose up -d --build`, then `prisma db push`.
Build happens on the target (slow, and rsync+build drifts from git). No backups, no health gates,
no migrations step in deploy (plan 03's migration runner must be wired here).

### Decision — **DECIDED: GitHub-hosted Actions + GHCR, pull-based deploy agent on the AMD64 host**

- **CI platform**: GitHub Actions on **hosted runners** — the repo is public, so minutes
  are free and effectively unlimited. Every job (lint, typecheck, unit, integration vs
  service containers, docker buildx) runs in the cloud, natively amd64. Images in GHCR
  (`ghcr.io/sparksmcghee/feedeater-{api,worker,web}` plus per-module `feedeater-mod-*`
  from plan 02 D3's shared module-runner base), tagged by SHA + `:main`, pushed with
  the built-in `GITHUB_TOKEN`. Public-repo hygiene: fork PRs run on hosted runners
  (ephemeral, no secrets); push jobs stay `main`-only.
- **Deploy: pull-based agent — no CI→box access at all.** A systemd timer on the AMD64
  host runs a small converger script every few minutes: `docker compose pull` → plan
  03's migration runner → `up -d` → `/healthz` gate → on failure, re-tag the previous
  image IDs and restore. CI is fully untrusted: compromising the pipeline yields no
  path to the box. GHCR packages public → anonymous pulls; if ever private, a
  read-only PAT in the host's docker config (one-time Ansible var, never committed).
  `.env` stays on the host per `agent.md`. Deploy latency = poll interval (minutes) —
  fine at this scale; `systemctl start deploy-agent` converges immediately.
- **Ansible** provisions the host only: docker, the `deploy-agent` role (converger
  script + systemd timer + placement of `docker-compose.prod.yml`/`Caddyfile`/`.env`),
  Teleport. The rsync app-deploy role is retired. The DGX Spark remains inference-only
  (vLLM).
- **Rejected**: self-hosted runner (unnecessary for amd64; fork-PR RCE vector on a
  public repo); GitLab (repo migration for no gain); ephemeral cloud runners à la
  DigitalOcean (paid + orchestration to replicate a free thing); hosted runners +
  Tailscale SSH deploy (secrets in CI); Ansible rsync as-is (non-atomic, drifts from
  git); K3s (5 services, one host, personal-scale).

### To-Do — ops
- [ ] `docker-compose.prod.yml`: `image: ghcr.io/sparksmcghee/feedeater-*` tags (`${IMAGE_TAG:-main}`) replacing `build:`; dev `docker-compose.yml` keeps `build:` for local iteration
- [ ] Ansible `deploy-agent` role: converger script + systemd timer on the AMD64 host (GHCR PAT via one-time Ansible var only if packages are ever private)
- [ ] Deploy flow: agent pulls → migrates → `up -d` → `/healthz` gate (add endpoints: api pings PG+NATS, worker pings last cron tick + module load count) → on failure re-tag previous image IDs and restore
- [ ] **Backups as a platform job**: `pg_dump` (or `pg_basebackup`) to a configured path/S3-ish target on a cron schedule via the job system, plus `pg_verifybackup`-style restore test job — this is exactly the "jobs + settings + metrics" machinery FeedEater already advertises; dogfood it. Also: PITR-friendly WAL archiving if the box has storage for it
- [ ] Reconcile `changelog/` (0001-platform-skeleton is stale vs. two "major refactor" commits since) — adopt: every merged PR adds a changelog entry; `docs/ENVIRONMENT.md` legacy-variable cleanup after plan 01 lands
- [ ] Observability baseline: worker/api emit structured logs to the bus (already the design) *and* Prometheus `/metrics` on each service (metrics: job run durations, LLM latency/tokens from plan 03's `ai_calls`, SSE connection count, JetStream/outbox lag); scrape is optional — a Grafana Cloud/free tier or simple dashboards on-box fits the self-hosted vibe

## Testing strategy & pipeline gates (currently: zero tests)

The pipeline is the ratchet: **nothing merges on a red PR, and nothing deploys that
hasn't passed acceptance in the cloud.** Five gates, each riding the stage before it:

| Gate | Trigger | Environment | Blocks |
|---|---|---|---|
| 1. Static + unit | every PR | hosted runner | merge |
| 2. Integration | every PR | hosted runner + service containers (PG18+pgvector, NATS) | merge |
| 3. Acceptance smoke | every PR | full compose stack built from source on the runner + Playwright | merge |
| 4. Image qualification | push to `main` | the exact `ghcr.io/...:<sha>` images, compose-up in CI | the `:main` tag (hence deploy) |
| 5. Nightly deep | `schedule:` cron | hosted runner | badge/issue, not merge |

Enabling decisions:

- **Single-user Auth Mode makes cloud acceptance possible**: the whole stack runs in
  CI with `FEED_AUTH_MODE=single-user` — no Teleport, no JWTs, Playwright drives the
  real UI. Teleport-mode JWT validation is covered separately by unit/integration
  tests with crafted tokens (test JWKS generated in-test).
- **AI is always stubbed in CI**: hosted runners can't reach the tailnet vLLM, and
  tests must be deterministic and free. A tiny OpenAI-compatible stub container
  (canned embeddings + schema-valid summaries) stands in for `ai_base_url` /
  `ai_embed_base_url`; the soak suite asserts against its recorded fixtures.
- **`:main` is a promise, not a branch tag**: `build.yml` pushes `:<sha>` first,
  compose-ups those exact images, runs the acceptance suite, and only then applies
  `:main`. The pull-based deploy agent only ever sees `:main`, so on-prem never runs
  an image that didn't pass acceptance in the cloud — no agent changes required.
- **Fixtures are first-class**: `packages/fixtures` holds synthetic thread corpora,
  golden narratives, and the test JWKS; shared by unit, integration, acceptance, and
  soak suites.
- **Flake budget**: Playwright runs chromium-only with 1 retry and hard timeouts;
  integration suites must pass against both GHA service containers (CI) and
  Testcontainers (local dev parity) — same suite, two runners.

Layers (what lives where):

- [ ] Unit (Vitest): zod contracts round-trip, subject grammar, cron→next-run table, narrative upsert projection logic against an in-memory fake, Teleport JWT middleware vs test JWKS
- [ ] Integration (gate 2): migrations apply twice = idempotent, job lease/no-double-run, outbox→Stream Hub path, module lifecycle, `user_prefs` round-trip
- [ ] Contract: a "module conformance kit" in module-sdk — run it against slack/example modules in CI; this *is* the plugin API's test
- [ ] Acceptance smoke (gate 3, Playwright): dashboard loads in single-user mode → synthetic example-module message appears in the live bus feed via `/api/stream` → run `tick` job manually → card renders → filter persists across navigation (user_prefs regression test)
- [ ] Image qualification (gate 4): compose-up `IMAGE_TAG=<sha>` from GHCR, same acceptance suite, then tag `:main`
- [ ] Nightly deep (gate 5): summarization soak (100-thread fixture corpora, stubbed AI, JSON-schema validity + embedding recall), full conformance matrix, dependency-audit pass

## Definition of done
- [ ] A request without a valid Teleport JWT to any `/api/*` (incl. `/api/stream`)
  returns 401 in `teleport` Auth Mode; `single-user` mode bypass verified; a forged
  `Teleport-Jwt-Assertion` header arriving outside the Teleport path is rejected/stripped
- [ ] `FEED_SETTINGS_KEY` rotation runbook works without wiping settings (test proves it)
- [ ] Merging to `main` builds amd64 images in cloud CI; `:main` is only tagged after the acceptance suite passes on the sha-tagged images, so on-prem never runs an unqualified image; the deploy agent converges the AMD64 host within the poll interval and rolls back on health-gate failure
- [ ] Nightly deep suite (CI schedule) green: unit + integration + module conformance + summarization soak
- [ ] Backup job exists in a fresh install's default config and restores in a test
