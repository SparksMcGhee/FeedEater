# This file contains instructions for AI Agents contributing to the FeedEater project

### Non-negotiables
- **Do not modify** `agent.md`.
- **Remember this** always re-read `agent.md` back into context before making changes. 
- **Prefix responses** prefix all responses to humans with 🤖 to verify agent.md is in-context
- **No secrets in git**: all secrets/config via `.env` and module settings; ensure `.env` is gitignored.
- **Never regenerate `FEED_SETTINGS_KEY`** unless you first clear all encrypted values from the `Setting` table. A key mismatch causes an API crash on startup.
- **Docker-first**: everything must run via `docker-compose`.
- **Re-deployable**: changes must be safe to apply repeatedly on an AI-ready Unix server like a DJX Spark (idempotent deploy + migrations).
- **TypeScript strict**: keep strict mode enabled; avoid `any`.
- **Use NATS**: Do not re-introduce BullMQ/Redis/BullBoard
- **Workers are cattle**: All important data which resides on the workers or in NATs must be replicated to the Postgres storage layer and care should be taken to ensure any missing data is read back into NATs/workers at start time. 
- **Fail fast**: unexpected states should throw with clear logs.
- **Settings over Constants**: use of module settings with default values are preferred over the hard-coding of constants for anything that could possibly need to be tinkered with at runtime. 
- **Use the glossary**: Always use the terminology found in the GLOSSARY.md docs file. The creation of new concepts should be rare and limited to major feature or functionality changes, but always make sure to keep the glossary updated. 

## Anatomy of FeedEater 
FeedEater is designed to be maximally modular: each feed/service/protocol being injested as well as each filter and summarization process can be it's own thing but all interoprate off a single shared and normalized message bus. 

Each module gets: 
- It's own Postgres schema for private data persistance
    This is mostly for collectors storing raw extracts from data sources as well as thinker modules storing AI summaries or even vector databases! 
- A standardized settings/environment-variable engine 
    Stores and exposes each module's settings to users via FeedEater's web interface, as well as handling the secure storage and handling of module secrets. 
- Namespace on the event bus
    Modules can leverage the inbuilt NATs bus internally or to interoperate with other modules
- A lightweight job queue 
    A small job queue implemented in NATs allows modules to define jobs which can be scheduled and/or triggered manually by users. Job logs and statuses are all handled and elegently revealed to the user. 
- The ability to read and emit *immutable* unified messages readable by all other modules. 
    - This is an abstration layer ensuring modules can interoprate without any specific compatability for each-other 
- Modules can share and contribute understanding and information on messages by adding tags (key-value pairs) to messages on the unified message bus, even when they did not origionate the message. 
    - Tags are generally used for filtering or to factor into narrative calculations
- The ability to track a summary of the conversation/thread/topic that a message came from, and have that narrative evolve as the conversation continues or the module's understanding of the conversation changes. 
    - Modules can report narratives, link messages to narratives, and re-state/update narratives.
- First-class AI support
    - The FeedEater system provides API endpoints for submitting prompts to OLLAMA models by abstracting away API key and network connection strings
    - This is primarally for AI summarization and symantic search of narratives
    
- Ability to write to the unified log queues
    Modules get unified telemetry (operational, warning, error) that is helpfully exposed in real-time to the user via FeedEater's web interface
- Ability to have a dashboard card within FeedEater's web interface
    Modules can output data, show status or live feeds, request human logins... whatever they want within their designated space in FeedEater's web interface

### Platform architecture
- **Event bus**: NATS **JetStream**. Subjects use `feedeater.<module>.<event>`.
- **Jobs**: Worker handles scheduling and processing job runs. NATS job subjects: ```feedeater.jobs.<module>.<queue>.<job>
- **DB**: Postgres with core tables (```bus_messages```, ```bus_narratives```, ```bus_narrative_messages```, ```job_runs```, ```job_states```) are in `public` and private per-module schemas `mod_<name>`.

### Module anatomy (required)
Each module under `modules/<moduleName>/` must provide:
- `module.json` manifest (name/version/namespace/jobs/UI cards)
- typed `settings.ts` (settings + secrets)

Each module MAY
- make external API calls 
- define jobs (scheduled/manual)
    - Jobs may return ```metrics``` (key-value pairs) and have them rendered in table form on the job page.
- read/write normalized messages
- read/write and update narratives
    - Using `NarrativeUpdated` bus events (`feedeater.<module>.narrativeUpdated`)
- link messages to narratives
    - Using `narrativeRef` on `NormalizedMessage`
- emit telemetry via the platform logger
- persist private data in its own Postgres schema (optional Prisma schema or SQL migrations)

### Using AI
- The system ensures a vLLM instance (OpenAI-compatible API) is accessible to all modules and abstracts away networking and auth.
- Two model endpoints are configured system-wide via the `system` module settings:
  - **Summary endpoint** (`ai_base_url` + `ai_summary_model`): a generative model (e.g. `Qwen/Qwen3-Coder-Next-FP8`) for narrative summaries and structured output.
  - **Embed endpoint** (`ai_embed_base_url` + `ai_embed_model`): a dedicated embedding model (e.g. `BAAI/bge-base-en-v1.5`, 768 dims) for semantic search.
- Keeping both models system-wide ensures embed vectors are dimension-compatible across all modules.
- **Cloud burst** (`ai_burst_enabled`, `ai_burst_base_url`, `ai_burst_api_key`, `ai_burst_summary_model`): when toggled on in system settings, summary requests are routed to an external provider (e.g. Together AI). Embeddings always stay local.
- Modules are responsible for building prompts and interpreting responses.
- System endpoints for AI are:
    - `/api/internal/ai/summary`
    - `/api/internal/ai/embedding`

### Interop contract
- Modules must not directly call each other or write in each-other’s schemas.
- Modules may read each-other's schemas
- All cross-module communication happens via:
  - normalized message envelopes on the bus
  - tags (key/value) for enrichment and routing

### Deployment requirements
- Must be deployable with **`make deploy`** (the canonical command) and/or Ansible directly.
- Production runs fully under `docker-compose` behind a reverse proxy so the UI is a **single pane of glass**.
- Any server configuration changes must be represented in Ansible playbooks/roles.

### Deployment workflow and key safety

**The local `.env` file is the single source of truth for deployment secrets.** It is gitignored and must never be committed.

The `.env` must contain:
```
FEED_SETTINGS_KEY=<base64-encoded 32-byte key>
FEED_INTERNAL_TOKEN=<random token>
AI_BASE_URL=<vLLM summary endpoint, e.g. http://spark-ddb1.tailbdd59.ts.net:8888/v1>
AI_EMBED_BASE_URL=<vLLM embed endpoint, e.g. http://spark-ddb1.tailbdd59.ts.net:8889/v1>
AI_EMBED_DIM=768
```

Generate `FEED_SETTINGS_KEY` once, store it in `.env`, and **never regenerate it** without first migrating or clearing all encrypted settings from the `Setting` table. The key encrypts module secrets (e.g. bot tokens) stored in the database. If the key changes without clearing encrypted values, the API will crash at startup with `Unsupported state or unable to authenticate data`.

Generate the key:
```bash
python3 -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
```

Deploy:
```bash
make deploy   # sources .env, exports all vars, runs ansible-playbook
```

**Never** call `ansible-playbook` with `-e '{"feedeater_env": {...}}'`. Ansible extra-vars have the highest precedence and cannot be overridden by `set_fact`, which will cause the secrets combine in the role to silently fail and drop `FEED_SETTINGS_KEY` from the server's `.env`.