# Plan 01 — Modernize the Stack (Runtime, Dependencies, Build, Docker, CI)

Goal: move every part of the toolchain from "early-2025 defaults" to current stable, and make
builds reproducible and CI-guarded so the later refactor plans (02–04) land on a modern base.

## Decision Points

### D1. Node baseline — **DECIDED: Node 24 LTS**
| Option | Notes |
|---|---|
| **Node 24 LTS (DECIDED)** | Current active LTS ("Krypton"). Ships stable `node --watch`, built-in test runner, better ESM resolution. Chosen outright — this is a re-implementation, no reason to hedge. |
| Node 22 | Fallback only if a dep breaks on 24. |

### D2. Web framework — **DECIDED: Next 16 + React 19 (in place)**
| Option | Notes |
|---|---|
| **Next 16 + React 19 (DECIDED)** | Turbopack default, async `params`/`cookies`, new cache semantics — a real migration, but the rewrite appetite is already budgeted; keeps SSR + App Router for the RSC page shells in plan 04. Also closes the Next 14 security liability (plan 04). |
| Vite + React SPA behind the API | Rejected: loses the RSC page shells; the one-Node-service saving doesn't justify a second frontend architecture decision. |

### D3. HTTP server for `apps/api` — **DECIDED: Hono (agent's choice)**
| Option | Notes |
|---|---|
| **Hono (DECIDED)** | The plan's own caveat triggered: "consider if the API grows middleware needs" — plan 04's Teleport-JWT auth middleware is exactly that. First-class SSE via `hono/streaming` (fits the `/api/stream` Stream Hub), `@hono/zod-validator` wires straight into the existing core zod contracts, best-in-class TS inference, tiny surface on `@hono/node-server` (Node 24). Rewrite cost is already budgeted — plan 02 decomposes the API regardless. |
| Express 5 | Rejected: the drop-in/minimal-churn argument is moot in a re-implementation. |
| Fastify | Rejected: mature and fast, but JSON-schema-centric validation adds friction against the existing zod contracts. |

### D4. ORM / DB access layer — **DECIDED: Drizzle + postgres.js**
| Option | Notes |
|---|---|
| **Drizzle + postgres.js (DECIDED)** | SQL-first formalized: the worker and slack module already bypass Prisma with raw `pg` everywhere, and `vector`/`halfvec` columns become first-class typed citizens instead of `Unsupported("vector")` workarounds — embeddings on the same footing as the rest of the data. All Prisma call sites get rewritten and Prisma is removed entirely (no two-tools outcome). Pairs naturally with plan 03 D2's versioned SQL migrations. |
| Prisma 7 | Rejected: the TS-engine rewrite is nice, but Prisma still can't type vectors and keeps a second schema DSL between us and SQL. |
| Keep Prisma 6 | No. |

### D5. Lint/format + test runner — **DECIDED: Biome + Vitest (agent's choice)**
| Option | Notes |
|---|---|
| **Biome + Vitest (DECIDED)** | Biome: one binary for lint+format on a greenfield-shaped monorepo (eslint 8 is EOL; `next lint` is removed in Next 16). Vitest: workspace-aware, runs against real Postgres/NATS via testcontainers for plan 04's integration suite. |
| ESLint 9 flat config + Prettier + node:test | Rejected: three tools where one binary does; node:test lacks workspace ergonomics. |

### D6. CI/CD platform & where builds happen — **DECIDED**
| Option | Notes |
|---|---|
| **GitHub Actions (hosted) + GHCR + pull-based deploy agent (DECIDED)** | The repo is **public** at `SparksMcGhee/FeedEater` → GitHub-hosted runners are free and effectively unlimited. All lint/test/build jobs run in the cloud, natively amd64 (matching the deploy target; the DGX Spark stays inference-only on vLLM). Images push to GHCR with the built-in `GITHUB_TOKEN`. Deploys: a systemd-timer **deploy agent** on the AMD64 host polls GHCR and converges (pull → migrate → up → health-gate → rollback) — CI has zero access to the box, no runner to maintain, nothing in CI beyond `GITHUB_TOKEN`. See plan 04's ops decision for the deploy flow. |
| Self-hosted runner on the deploy host | Rejected: unnecessary once the target moved to amd64 (hosted runners build natively), and a self-hosted runner on a *public* repo is a fork-PR RCE vector for PR-triggered jobs. |
| GitLab CI + GitLab registry | Rejected: repo migration for no functional gain; self-hosting GitLab CE violates keep-it-simple. |
| Ephemeral cloud runners (DigitalOcean etc.) | Rejected: paid droplets + registration orchestration to replicate what hosted runners provide free. |
| Hosted runners + Tailscale SSH deploy | Rejected: Tailscale authkey + SSH deploy key in CI secrets; the pull-based agent keeps CI fully untrusted. |

## To-Do

### Runtime & deps
- [ ] Bump `engines.node` to `>=24`; update `docker/Dockerfile.*` bases to `node:24-alpine`
- [ ] Upgrade `next@16`, `react@19`, `@types/react@19`; fix async `params`/`cookies` in `app/modules/[name]/page.tsx` and other App Router pages; switch `next dev`/`build` to Turbopack flags
- [ ] Re-implement `apps/api` on Hono (`@hono/node-server`): port the 10 route modules onto `@hono/zod-validator` + core zod contracts, use `hono/streaming` SSE helpers for plan 04's `/api/stream` Stream Hub; lands together with plan 02's API decomposition
- [ ] Replace Prisma with Drizzle + postgres.js: rewrite `packages/db` as a Drizzle schema (typed `vector`/`halfvec` columns via pgvector custom types), port every Prisma call site (api routes, worker archiver/narrative upserter), delete `@prisma/client` + `schema.prisma`, replace the `Makefile:db-push` wrapper with plan 03's migration runner
- [ ] Bump compose images: `pgvector/pgvector:pg18` (paired with plan 03), `nats:2.10-alpine` → current `nats:2.x-alpine`, `caddy:2-alpine` → pin `caddy:2.10-alpine` (or current patch)
- [ ] Remove Ollama-era leftovers while bumping: `ollama_*` settings in `modules/system/module.json` and the legacy fallback chain in `apps/api/src/ai.ts` (keep behind one release if live installs need it)

### Build reproducibility
- [ ] All Dockerfiles: `COPY package-lock.json` + `npm ci` instead of `npm install` (currently `docker/Dockerfile.api:15` and siblings ignore the committed 286 KB lockfile)
- [ ] Deduplicate the three near-identical Dockerfiles into one parameterized file (`ARG TARGET`) or a shared base stage
- [ ] Pin versions in `package.json` (`^` → exact) or add `packageManager` field + lockfileVersion guard in CI
- [ ] Replace `tsup`-only builds with `tsup` + `tsc --noEmit` in CI (already scripts; just wire them up)

### Repo tooling
- [ ] Add Biome (`biome.json`), delete the `"(no lint configured yet)"` lint stubs in all 9 `package.json`s
- [ ] Add Vitest workspaces config (`vitest.workspace.ts`) covering `apps/*`, `packages/*`, `modules/*`
- [ ] Add `.github/workflows/ci.yml` (hosted runners) implementing plan 04's pipeline gates: gate 1 (lint + typecheck + unit) and gate 2 (integration vs service containers `pgvector/pgvector:pg18`, `nats:2.x`) on every PR, growing to gate 3 (compose acceptance smoke); `main` branch protection requires these checks so the AI-agent commits (per `agent.md`) can't land red
- [ ] Add `.github/workflows/build.yml` (hosted runners, `main` only): buildx the platform images (api, worker, web) + per-module images from the shared module-runner base (plan 02 D3), natively for amd64 with GHA cache; push `ghcr.io/sparksmcghee/feedeater-*:<sha>` + `:main`
- [ ] Add `.env.example` (referenced by `Makefile:deploy` but not in the repo)

### Definition of done
- [ ] `make up` builds reproducibly from lockfile on Node 24 images
- [ ] CI green on a clean clone with zero manual steps
- [ ] `npm run lint` and `npm test` do something real in every workspace
