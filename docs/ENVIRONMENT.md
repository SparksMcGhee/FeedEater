## Environment variables

FeedEater is configured entirely via environment variables (typically through a `.env` file used by `docker compose`).

### Required
- `DATABASE_URL`: Postgres connection string
- `NATS_URL`: NATS connection string
- `FEED_SETTINGS_KEY`: **32-byte key**, base64-encoded, used to encrypt secrets at rest
- `FEED_INTERNAL_TOKEN`: internal bearer token used by the worker to fetch decrypted module secrets from the API

Generate `FEED_SETTINGS_KEY` like:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Common compose defaults

```bash
POSTGRES_USER=feedeater
POSTGRES_PASSWORD=feedeater
POSTGRES_DB=feedeater
DATABASE_URL=postgresql://feedeater:feedeater@postgres:5432/feedeater
NATS_URL=nats://nats:4222
FEED_SETTINGS_KEY=<generated>
FEED_INTERNAL_TOKEN=<random_string>
AI_BASE_URL=http://spark-ddb1.tailbdd59.ts.net:8888/v1
AI_EMBED_BASE_URL=http://spark-ddb1.tailbdd59.ts.net:8889/v1
AI_EMBED_DIM=768
```

### AI — summary endpoint (local vLLM, port 8888)
- `AI_BASE_URL`: Base URL of the vLLM chat/completions instance (OpenAI-compatible `/v1` prefix).
- `AI_SUMMARY_MODEL`: Model name for context summaries. Default: `Qwen/Qwen3-Coder-Next-FP8`.
- `AI_API_KEY`: Bearer token for the summary endpoint. Leave unset if vLLM has no auth.

### AI — embed endpoint (local vLLM, port 8889)
- `AI_EMBED_BASE_URL`: Base URL of the dedicated vLLM embedding instance (OpenAI-compatible `/v1` prefix).
- `AI_EMBED_MODEL`: Model name for embeddings. Default: `BAAI/bge-base-en-v1.5`.
- `AI_EMBED_DIM`: Embedding vector size. **Must match the model output dimension.** Default: `768`.

### AI — cloud burst (optional)
When enabled, summary requests are routed to an external provider (e.g. Together AI) instead of the local instance — useful when the local GPU is under sustained coding load.

- `AI_BURST_ENABLED`: Set to `true` to activate. Default: `false`. Also controllable as a live system setting without restart.
- `AI_BURST_BASE_URL`: External provider base URL. Default: `https://api.together.xyz/v1`.
- `AI_BURST_API_KEY`: API key for the burst provider.
- `AI_BURST_SUMMARY_MODEL`: Model to request from the burst provider. Default: falls back to `AI_SUMMARY_MODEL`.

### System settings (DB-backed, editable in the UI without restart)
- `ai_base_url`: Overrides `AI_BASE_URL` for the summary endpoint.
- `ai_summary_model`: Overrides `AI_SUMMARY_MODEL`.
- `ai_api_key`: Overrides `AI_API_KEY`.
- `ai_embed_base_url`: Overrides `AI_EMBED_BASE_URL`.
- `ai_embed_model`: Overrides `AI_EMBED_MODEL`.
- `ai_embed_dim`: Overrides `AI_EMBED_DIM`.
- `ai_burst_enabled`: Toggle cloud burst on/off without a restart.
- `ai_burst_base_url`: Overrides `AI_BURST_BASE_URL`.
- `ai_burst_api_key`: Overrides `AI_BURST_API_KEY`.
- `ai_burst_summary_model`: Overrides `AI_BURST_SUMMARY_MODEL`.
- `context_top_k`: System-wide top-K message retrieval for context updates.
- `dashboard_show_ids`: Show message/context IDs in the dashboard when true.

### Legacy Ollama variables (still accepted as fallbacks)
The following are still read as fallbacks if the `ai_*` equivalents are not set. They can be left in place during migration and removed afterward.
- `OLLAMA_BASE_URL` → falls back for `AI_BASE_URL`
- `OLLAMA_SUMMARY_MODEL` → falls back for `AI_SUMMARY_MODEL`
- `OLLAMA_EMBED_MODEL` → falls back for `AI_EMBED_MODEL`
- `OLLAMA_EMBED_DIM` → falls back for `AI_EMBED_DIM`

### One-time DB migration note
`BAAI/bge-base-en-v1.5` outputs **768-dimensional** vectors. If you previously ran FeedEater with a 4096-dim embedding model (e.g. `llama3.1:8b`), the `bus_contexts.embedding` and `mod_slack.slack_message_embeddings.embedding` vector columns must be recreated at the new dimension:

```sql
ALTER TABLE bus_contexts DROP COLUMN IF EXISTS embedding;
ALTER TABLE mod_slack.slack_message_embeddings DROP COLUMN IF EXISTS embedding;
```

The worker's `ensureContextStorage` function will recreate `bus_contexts.embedding` automatically on next start. The `slack_message_embeddings` column is recreated by the Slack module migrations. Existing stored embeddings will be regenerated naturally on the next `collect` and `updateContexts` cron runs.
