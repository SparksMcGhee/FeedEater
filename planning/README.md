# FeedEater Re-Implementation Plans — Index

Planning docs for a ground-up refactor of FeedEater. Each doc is a self-contained to-do README
with **Decision Points** (pick options before starting) and an ordered **To-Do** checklist.

| Doc | Theme | Effort | Risk if skipped |
|---|---|---|---|
| [01-modernize-stack.md](01-modernize-stack.md) | Runtime, dependencies, build, Docker, CI | M | EOL/patched deps, non-reproducible builds, silent drift |
| [02-decompose-platform-core.md](02-decompose-platform-core.md) | Worker/API decomposition, module SDK, scheduler, bus patterns | L | The 719-line worker monolith keeps accreting module-specific logic |
| [03-data-search-ai.md](03-data-search-ai.md) | Postgres 18, pgvector/HNSW, migrations, hybrid search, AI gateway | M | Fragile embeddings story, schema drift, brittle JSON parsing of LLM output |
| [04-product-ops-security.md](04-product-ops-security.md) | Web app, realtime UX, auth, deploy, observability, testing | L | **No authentication at all** on a tool that holds Slack tokens |
| [05-implementation-sequence.md](05-implementation-sequence.md) | Execution order: CI/CD first, then progressive re-implementation | — | Refactor lands red; deploys drift; big-bang risk |

## Current state (as of `df5eba5`, Sep 2026)

Everything is TypeScript ESM in an npm-workspaces monorepo:

```
apps/api      Express 4 SSE+REST bridge   (10 route modules, ~1,100 lines)
apps/worker   719-line monolith: module loader + cron + job dispatcher
              + bus archiver + narrative upserter + schema self-healing
apps/web      Next.js 14 dashboard, all live data via 3 separate SSE endpoints
modules/*     slack (the only substantive one), example, system
packages/*    core (zod contracts + NATS subjects), db (Prisma 6), module-sdk (types only)
infra         docker-compose (PG16+pgvector, NATS 2.10, Caddy :666), Ansible rsync deploy
```

Verdict: the **concept is strong** (modular feed backplane, narratives-as-king, bus-only
interop) but the **implementation violates its own rules** and is built on now-dated choices:

- Platform code hardcodes Slack: `apps/worker/src/index.ts:173-200` queries
  `mod_slack.slack_messages` directly from the narrative upserter — a direct breach of the
  "no cross-module DB access" rule in `docs/ARCHITECTURE.md`.
- Hand-rolled cron (`index.ts:305-346`) supports only `*`, `*/n`, fixed-minute patterns
  and silently returns `null` otherwise.
- Three parallel SSE endpoints, each opening one raw NATS subscription **per browser tab**.
- Two schema sources of truth: Prisma `db:push` plus runtime "self-healing" DDL
  (`ensureNarrativeStorage`, slack's `ensureSchema` duplicating `sql/schema.sql`).
- Zero tests, zero lint (`"(no lint configured yet)"` in every package.json), zero CI.
- Dockerfiles run `npm install` and never copy the lockfile → non-reproducible builds.
- The only "auth" is Caddy same-origin + a shared `FEED_INTERNAL_TOKEN`; the dashboard and
  all `/api/*` routes are unauthenticated, and `docker-compose.yml` ships a placeholder
  `FEED_SETTINGS_KEY` default.
- Stack is one-to-two majors behind: Node 20→24 LTS, Next 14→16, React 18→19,
  Express 4→Hono, Prisma→Drizzle, PG16→18.

## Recommended sequencing

**Decided — see [05-implementation-sequence.md](05-implementation-sequence.md).** All
decision points in 01–04 are resolved. Execution is: commission the self-hosted runner
and stand up CI/CD on the *current* app first (Phases 0–1), then progressively
re-implement in dependency order — modern foundation (01) → platform decomposition
(02) → data/search/AI (03) → product surface & security (04) — with every phase ending
green and deployable. The only standing caveat: plan 04's auth items jump the queue if
the service is ever reachable *without* Teleport in front.

## Things deliberately kept (not up for refactor)

These aged well — recommend no change:

- **NATS JetStream as the bus** — right-sized, still current (`nats:2.10-alpine` just needs
  a version bump). Replacing it (Redis Streams, Kafka, Valkey) adds ops weight and violates
  `agent.md`'s "no BullMQ/Redis" rule without benefit at this scale.
- **Postgres as the single source of truth** ("workers are cattle") — sound; all
  reconstructability work in 02/03 reinforces rather than replaces it.
- **The domain model** — NormalizedMessage, tags, narratives, FollowMe panels, per-module
  schemas + namespaces — is coherent and documented; keep the glossary, fix the enforcement.
- **Caddy** as reverse proxy — keep.
