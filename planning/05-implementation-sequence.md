# Plan 05 — Implementation Sequence (Plan of Attack)

All decision points in plans 01–04 are resolved. This doc is the execution order.

## Principles

1. **Pipeline first.** Every change after Phase 1 lands as a PR riding CI + image-based
   deploys. No more rsync-and-pray.
2. **Always deployable.** Each phase ends with green CI and a deployable `main`. No
   long-lived refactor branches drifting from reality.
3. **Behavior-preserving before behavior-changing.** Phase 2 modernizes the stack
   without changing what the product *does*; Phases 3+ change architecture. Diffs stay
   reviewable, regressions stay attributable.
4. **Data is sacred.** Any Postgres cut-over is preceded by a manual `pg_dump`; the
   automated backup job (plan 04) exists before the riskiest migrations land.

## Phase 0 — Repo gates · S

Goal: `main` is protected and the repo is ready for CI. (No runner to commission —
hosted runners + the pull-based deploy agent removed the last box-side prerequisite.)

- [ ] Inventory: new `[feedeater]` group in `ansible/inventory.ini` for the AMD64
  hypervisor host (x86_64, same fleet as `botpen`). The DGX Spark is retired as the
  app deploy target — it stays inference-only (vLLM)
- [ ] Branch protection on `main`: PRs required; required status checks added once
  `ci.yml` lands in Phase 1. (Public repo: fork PRs run on hosted runners — keep
  secrets out of PR-triggered workflows; push jobs stay `main`-only.)
- [ ] `.env.example` (plan 01 to-do; `Makefile:deploy` already references it)

**Exit:** nothing merges to `main` without a PR.

## Phase 1 — Walking-skeleton pipeline · M

Goal: deploy the **current, unmodified app** via cloud CI + the deploy agent. Prove
the mechanics on a known-good system before app changes can confound debugging.

- [ ] Reproducible Dockerfiles (plan 01): `COPY package-lock.json` + `npm ci` in all
  three; dedupe into one parameterized file / shared base stage
- [ ] `.github/workflows/ci.yml` (hosted, PRs): `npm ci` → `tsc --noEmit` →
  `docker compose build` sanity → full-stack compose smoke (up → `/api/health` → web
  200 → down) as the seed of acceptance gate 3. Lint/test stages light up in Phase 2
- [ ] `.github/workflows/build.yml` (hosted, `main` only): buildx amd64 with GHA cache →
  push `ghcr.io/sparksmcghee/feedeater-{api,worker,web}:<sha>` → compose-up those exact
  images → smoke → only then tag `:main` (image qualification, gate 4 — the deploy
  agent only ever pulls `:main`, so on-prem never runs an unqualified image)
- [ ] `docker-compose.prod.yml`: `image:` tags (`${IMAGE_TAG:-main}`) replacing `build:`;
  dev compose keeps `build:`
- [ ] Ansible `deploy-agent` role + `deploy-agent.yml`: places `docker-compose.prod.yml`
  + `docker/Caddyfile` + `.env` on the AMD64 host, installs the converger script as a
  systemd timer (default 2 min), optional GHCR login if packages are ever private
- [ ] Cut over: point the host at GHCR images; keep `make deploy` (rsync) as a legacy
  fallback for one release, then strip app-deploy tasks from the Ansible deploy role
  (Ansible keeps host provisioning: docker, deploy-agent, Teleport)

**Exit:** merging a trivial PR → images built in the cloud → the agent converges the
host within the poll interval; rollback to previous image IDs demonstrated once.

## Phase 2 — Modern foundation, behavior-preserving (plan 01) · L

Goal: the current product running on the 2026 stack. No product behavior changes.

- [ ] Node 24: `engines`, Docker bases, runner/dev docs
- [ ] Biome + Vitest wired into `ci.yml` (gate 1); seed unit tests (zod contracts
  round-trip, subject grammar, cron→next-run table) so the test stage is real from
  day one; integration gate 2 (service containers: migrations idempotent, outbox
  path); AI stub container + `packages/fixtures` shared test data
- [ ] Hono re-implementation of `apps/api` (route-for-route, same responses), Express removed
- [ ] Drizzle + postgres.js: `packages/db` schema, port all Prisma call sites, delete
  Prisma; `drizzle-kit` baseline migration capturing the *current* DDL; retire
  `Makefile:db-push` and the deploy.yml interim step
- [ ] PG16 → PG18 + pgvector 0.8 cut-over: **manual `pg_dump` first**, dump/restore
  into the new volume, one cut-over (plan 03 D1)
- [ ] Next 16 + React 19 migration (async `params`/`cookies`, Turbopack)

**Exit:** plan 01 definition-of-done; identical product behavior; every deploy via pipeline.

## Phase 3 — Platform decomposition (plan 02) · L

Goal: the monolith becomes the platform; modules become cattle.

- [ ] Outbox (D1): transactional `bus_messages`/`bus_tags` writes → NATS live signal;
  delete archiver, `_tags` consumer, startup re-emit, dedupe table
- [ ] croner scheduler + DB-leased job runs (D2)
- [ ] Platform config registry (D5): `modules/system` settings extracted, `aiDebug` → health endpoint
- [ ] Worker-per-module (D3): fully-remote `@feedeater/module-sdk` + module-runner
  entrypoint; port `modules/slack` as the reference module; compose profiles;
  per-module `feedeater-mod-*` images in `build.yml`
- [ ] `narrativeUpdated` carries `messageBusIds` (D4); delete the Slack-specific SQL
  from the worker
- [ ] Module conformance kit in module-sdk, run against slack in CI (the plugin API's test)

**Exit:** plan 02 definition-of-done (module-container kill test, no `mod_slack`
references in `apps/`, no double-scheduled jobs with two platform workers).

## Phase 4 — Data, search & AI (plan 03) · M

- [ ] `halfvec` + HNSW migrations; shared recall helper in core with iterative scans
- [ ] tsvector + GIN search column; hybrid `/api/bus/search` (RRF), replacing the
  client-side `dashboard_bus_search` filter
- [ ] AI gateway (`packages/ai`): single OpenAI-compatible client, `ai.json(schema, prompt)`
  structured output, embedding cache, batch embed endpoint, `ai_calls` request log,
  token/cost guardrail settings

**Exit:** plan 03 definition-of-done (DDL only in `migrations/`, recall quality test,
zero JSON-parse fallbacks in the soak test, idempotent re-deploys).

## Phase 5 — Product surface & security (plan 04) · L

- [ ] Teleport JWT auth middleware + `FEED_AUTH_MODE` single-user switch + ingress
  hardening. (Sequencing note: Teleport already brokers the edge, so the current
  exposure is contained — but if the box is ever reachable without Teleport, pull this
  item forward to Phase 1.)
- [ ] Stream Hub + `/api/stream` + `useFeedEaterStream`; delete the three SSE
  endpoints and the per-message-per-client Postgres lookups
- [ ] `user_prefs` + `/api/prefs`; filters move off `system` settings
- [ ] Card registry; narratives version-history UI; feed virtualization
- [ ] Backup job (dogfooded) + restore test; `/metrics` baseline; full `/healthz`
  (api pings PG+NATS, worker pings last cron tick + module count)
- [ ] Full Playwright acceptance suite (gate 3) covering both auth modes; nightly deep
  suite (gate 5): summarization soak + full conformance matrix

**Exit:** plan 04 definition-of-done.

## Phase 6 — Cut-over & hygiene · S

- [ ] Retire the legacy rsync deploy path entirely; `make deploy` becomes a thin
  wrapper documenting "push to main"
- [ ] Reconcile `changelog/`; refresh `docs/ENVIRONMENT.md` (new `FEED_AUTH_MODE` /
  `FEED_TELEPORT_*` vars, drop Ollama-era leftovers)
- [ ] User amends `agent.md` (agent-owned file): strike the Prisma option for module
  persistence; reword "vLLM instance" to "OpenAI-compatible inference endpoint"
- [ ] Update root `README.md` + `modules/README.md` to the post-refactor reality

## Why this order (and what would change it)

- **Pipeline before everything** because CI is the ratchet: once it exists, no commit
  lands red again, and every refactor PR is reproducibly built and deployed. (No
  runner commissioning needed at all — hosted runners + the pull-based agent removed
  the last box-side prerequisite.)
- **Pipeline on the current app before touching the app** so deploy-mechanics bugs
  (GHCR auth, compose prod drift, health gates) are debugged against a known-good system.
- **Foundation (2) before decomposition (3)** because porting call sites to
  Drizzle/Hono is mechanical while the architecture is stable; doing it after the
  split would multiply the porting surface across module processes.
- **Auth in Phase 5** is acceptable *only* because Teleport already brokers the edge;
  the app adding JWT validation is about user awareness (prefs, future RBAC), not
  about closing an open door. If that changes, auth jumps to Phase 1.
