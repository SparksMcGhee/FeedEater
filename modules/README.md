## FeedEater Modules (how to build one)

FeedEater is intentionally modular. **Adding a module should mean dropping a folder into `modules/`.**

This doc describes the minimum contract a module must satisfy and the recommended anatomy.

---

## Minimal requirements (to be runnable)

### 1) `module.json` manifest (required)

Every module folder must include `modules/<moduleName>/module.json`.

Required fields:
- `name`: module name (folder name should match)
- `version`
- `namespace`: NATS subject prefix, typically `feedeater.<moduleName>`
- `runtime.entry`: relative path to the built runtime entrypoint (example: `dist/runtime.js`)
- `queues`: list of job queues this module uses (example: `["mod_slack"]`)
- `jobs`: list of jobs the worker should schedule and/or subscribe to

Example (trimmed):

```json
{
  "name": "slack",
  "version": "0.0.1",
  "namespace": "feedeater.slack",
  "runtime": { "entry": "dist/runtime.js" },
  "queues": ["mod_slack"],
  "jobs": [
    { "name": "collect", "queue": "mod_slack", "schedule": "*/5 * * * *" }
  ]
}
```

### 2) Runtime entrypoint (required)

The worker dynamically imports your module’s runtime from `runtime.entry`.

Your runtime must export:
- `createModuleRuntime(): ModuleRuntime`

Where the module returns a handler map:
- `handlers[queueName][jobName] = async ({ ctx, job }) => { ... }`

The runtime `ctx` also exposes:

- `ctx.emitIngestRejected(...)`
- `ctx.emitHealthStatus(...)`

See reference implementations:
- `modules/example/`
- `modules/slack/`

---

## Recommended module folder anatomy

```
modules/<moduleName>/
  module.json
  package.json
  tsconfig.json
  README.md
  settings.ts
  src/
    index.ts
    runtime.ts
    ...other code...
  sql/
    schema.sql
  prisma/            (optional alternative to sql/)
    schema.prisma
```

- **`settings.ts`**: typed settings schema for the module (include secrets here too).
- **`sql/schema.sql` or `prisma/schema.prisma`**: private persistence schema; convention is `mod_<moduleName>`.
- **`src/runtime.ts`**: defines job handlers and uses `ctx` to access DB/NATS/queues/settings.

---

## Job + queue conventions

- Prefer queue names `mod_<moduleName>` (example: `mod_slack`).
- Jobs can be:
  - **scheduled** with `schedule` (cron string)
  - **event-triggered** with `triggeredBy` (NATS subject)
- The worker will:
  - schedule repeatable jobs from `module.json` via NATS job subjects
  - subscribe to `triggeredBy` subjects and publish job events for the configured queue

---

## Settings + secrets

- Module settings are stored in the platform DB and managed via the API.
- Secrets are encrypted-at-rest and **not returned** from the public settings endpoint.
- The worker fetches decrypted settings using an internal token (`FEED_INTERNAL_TOKEN`).

**Do not** read secrets from committed files. Use module settings for secrets.

---

## AI execution (module-owned prompts)

The API exposes internal AI endpoints that only execute models and return raw responses.
Modules are responsible for:

- assembling the prompt and any system instructions
- parsing the model response into their own data shape

Use `/api/internal/ai/summary` with a payload like:

```json
{ "prompt": "...", "system": "...", "format": "json" }
```

The response includes a `response` string from the model and optional `token_rate`.

---

## Database rules

- Each module owns a private Postgres schema: **`mod_<moduleName>`**.
- **Do not read or write other modules’ schemas.**

---

## Event bus rules (NATS JetStream)

- Subjects should follow: `feedeater.<moduleName>.<event>`
- Prefer emitting normalized messages on `feedeater.<moduleName>.messageCreated` when ingesting new content.
- Emit upstream drops on `feedeater.<moduleName>.ingestRejected`
- Emit liveness / freshness state on `feedeater.<moduleName>.healthStatus`

Recommended use:

- `ctx.emitIngestRejected(...)` when a module sees upstream data but drops it before publishing the normal event
- `ctx.emitHealthStatus(...)` for module-specific heartbeats or richer health details than the worker can infer

---

## “Drop-in module” checklist

- `module.json` includes `runtime.entry`
- `package.json` builds `dist/runtime.js`
- `src/runtime.ts` exports `createModuleRuntime()`
- module has at least one queue in `queues` and a handler for every job in `jobs`
- private schema is created on first run (fail fast if schema/table creation fails)

