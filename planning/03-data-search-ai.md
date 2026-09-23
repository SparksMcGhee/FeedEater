# Plan 03 — Data, Search & AI Layer (Postgres, pgvector, Migrations, LLM Gateway)

Goal: one source of schema truth, a current vector/search story, and an AI layer that uses
2026-era serving features instead of prompt-and-pray JSON parsing.

## Decision Points

### D1. Database version — **DECIDED: PostgreSQL 18 + pgvector 0.8.x**
| Option | Notes |
|---|---|
| **PostgreSQL 18 + pgvector 0.8.x (DECIDED)** | pg18 images with pgvector exist now; async I/O in PG18 helps the raw-`pg` worker + Drizzle/postgres.js paths. Migration: `pg_upgrade` or dump/restore — one cut-over together with the migrations overhaul below. |
| PostgreSQL 17 | Rejected: marginally more conservative, no benefit. |
| Stay on 16 (compose default) | Rejected: this is the base the whole vector story sits on. |

### D2. Schema management (currently split three ways!)
Today: Prisma `db push` (`Makefile:db-push`), runtime DDL self-healing
(`ensureNarrativeStorage` in `apps/worker/src/index.ts:78-121`), and module-level
`ensureSchema()` duplicated by hand-written `sql/schema.sql` in `modules/slack`. Pick one:

| Option | Notes |
|---|---|
| **Versioned SQL migrations + `migrate` library (DECIDED — forced by plan 01 D4's Drizzle choice)** | Numbered SQL files: platform `migrations/` + per-module `modules/<name>/migrations/`, applied atomically at deploy, tracked in a `schema_migrations` table. The Drizzle schema in `packages/db` is the typed client over these tables — no second schema DSL. Module migration files become part of the module contract (installed via module-sdk runner). Runner: `drizzle-kit migrate` (see to-do). |
| Prisma 7 migrations for platform, SQL files for modules | Rejected along with Prisma itself (plan 01 D4). |

Either way: **delete all runtime DDL**. `CREATE EXTENSION vector`, index creation, and
`vector(N)` column resizing become migration steps; a dim change becomes an explicit,
versioned re-embed operation, not an `ALTER TYPE` at boot.

### D3. Vector index & type — **DECIDED: HNSW + halfvec**
| Option | Notes |
|---|---|
| **HNSW + `halfvec` (DECIDED)** | pgvector 0.8: `halfvec` indexes up to 4k dims (768-dim bge embeddings fit easily), halves storage; HNSW + **iterative index scans** (`SET hnsw.iterative_scan = relaxed_order`) fixes the recall-collapse-under-filter problem today's ivfflat setup has (and which `ensureNarrativeStorage` even codes around by skipping indexes >2000 dims). |
| Keep IVFFlat + `vector` | Rejected: requires periodic retrain, worse filtered recall. |

Also: replace the narrative-similarity `<->` cosine query (`ingest.ts:673-685`) with the same
helper in core so all modules get one recall primitive.

### D4. Keyword & hybrid search — **DECIDED: tsvector first, ParadeDB as optional step 2**
Message search (`dashboard_bus_search`) is a Prisma `contains`/insensitive filter → `ILIKE`
full scans across `message`/`from` (`apps/api/src/busHistory.ts:30-34`) on every keystroke-bounded query.

| Option | Notes |
|---|---|
| **Postgres-native first: tsvector + GIN generated column (DECIDED, step 1)** | Free, no new image; language-agnostic `simple` config is fine for feeds; combine with pgvector for hybrid (reciprocal rank fusion in SQL). |
| ParadeDB `pg_search` (BM25) (accepted as optional step 2)** | Real BM25, facets, stemming. Needs the ParadeDB image (or self-built PG18 extension) — changes D1's packaging; only if hybrid recall proves needed for narratives search. |
| External engine (Meilisearch/Typesense) | Rejected: over-provisioned for a self-hosted backplane; violates the "Postgres is the truth" principle. |

### D5. Inference provider interface & structured output — **DECIDED: provider-agnostic OpenAI-compatible consumer**

Clarification (framing fixed): **FeedEater does not serve LLMs.** It is a pure *consumer*
of networked, industry-standard inference APIs — local vLLM, TogetherAI, OpenAI,
llama.cpp, TGI, or anything else speaking the OpenAI `/v1` surface. The self-hosted
vLLM instance is merely the default backend pointed at by config, never a platform
component.

| Option | Notes |
|---|---|
| **OpenAI-compatible consumer + standard structured output (DECIDED)** | The AI gateway (`packages/ai`) speaks only the OpenAI `/v1` surface (`chat/completions`, `embeddings`) against `ai_base_url`/`ai_embed_base_url` — swap providers by changing config, not code. Structured output uses the standard `response_format` JSON-schema field (supported by vLLM guided decoding, TogetherAI, and OpenAI alike), so the narrative prompt's *"Return strict JSON…"* + regex-fallback parsing (`ingest.ts:218-242`) becomes schema-validated output. The `ai.json(schema, prompt)` helper additionally validates with zod + retries once, absorbing per-provider quirks so any conforming provider works. |
| Ollama re-support | Rejected; the 92feddf migration away was right. Any OpenAI-compatible server (including Ollama's own `/v1` mode) already works through the same client — no provider-specific code. |
| Cloud burst | Keep as-is (settings-driven Together routing) — conceptually it becomes simply "point the summary provider at a different base URL + key"; move the burst *policy* out of `ai.ts` into the gateway. |

## To-Do

### Migrations overhaul (pairs with plan 02 D1/D2)
- [ ] Runner: `drizzle-kit migrate` (agent's choice — we already own the Drizzle dependency; it generates numbered SQL from schema diffs *and* applies them with a ledger table). Convert today's `packages/db/migrations/manual` into numbered migrations
- [ ] Migration for: platform tables, pgvector ext, HNSW/halfvec indexes, `search_index` tsvector column
- [ ] Module migration convention: `modules/<name>/migrations/*.sql`, applied on module install/upgrade via SDK; roles `mod_<name>` with `GRANT` scoped to own schema
- [ ] Remove `ensureNarrativeStorage`, slack `ensureSchema`, and `sql/schema.sql` duplication
- [ ] Embedding-dim change runbook: `ai_embed_dim` change → queue a `reembed` job (new platform job) → migrate column + backfill

### Vector & search
- [ ] Switch `bus_narratives.embedding` and `mod_slack.slack_message_embeddings` to `halfvec` + HNSW
- [ ] Enable iterative scans per-connection in the recall helper; benchmark top-K at `narrative_top_k` default 20
- [ ] Add hybrid search endpoint: `/api/bus/search` combining BM25/tsvector + cosine (RRF), replacing the client-side `dashboard_bus_search` filter
- [ ] Retention: monthly range-partition `bus_messages` (PG-native, no pg_partman needed at this volume) + a retention setting; JetStream `jetstream_max_age_seconds` only remains relevant if plan 02 D1 = keep JetStream

### AI gateway (new `packages/ai` or `apps/api` service class)
- [ ] Single OpenAI-compatible client used by api + worker (today: worker calls api which calls model; slack embeds via api too — keep the HTTP hop for modules, give in-process consumers the lib directly)
- [ ] Structured-output helper: `ai.json(schema: ZodType, prompt)` — requests `response_format` JSON-schema (standard OpenAI surface, works across vLLM/Together/OpenAI), validates + retries once, replacing manual JSON parsing/fallbacks
- [ ] Embedding cache table (`embedding, text_hash, model`) — dedupe identical text across modules; Slack re-collects history constantly (`lookbackHours`), currently re-embedding what it already has
- [ ] Batch embedding endpoint (`/api/internal/ai/embed` accepting arrays) + concurrency limits setting
- [ ] Per-purpose model routing settings (`ai_summary_model` / `ai_embed_model` exist; add `ai_tags_model`, keep burst overrides) and a request log (`ai_calls` table: tokens in/out, latency, model, caller) surfaced on the Jobs/Logs pages
- [ ] Token/cost guardrails as settings (settings-over-constants rule): max tokens per narrative refresh, daily burst budget

### Definition of done
- [ ] `grep -rn "CREATE TABLE\|CREATE EXTENSION\|ALTER TABLE" apps/ modules/` → matches only in `migrations/`
- [ ] Narrative recall quality: filtered top-K test with 10k messages returns ≥ expected neighbors (fails today with ivfflat + dim-skip logic)
- [ ] Zero JSON-parse fallbacks exercised in a 100-thread summarization soak test
- [ ] Re-deploying twice applies zero duplicate DDL (idempotency guaranteed by migration ledger, not runtime probing)
