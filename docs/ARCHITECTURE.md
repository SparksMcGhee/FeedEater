## FeedEater architecture (skeleton)

### Core concepts
- **Modules are plugins** under `modules/`. They should be independently deployable/disableable and should not tightly couple to other modules.
- **Interop is via the bus**: NATS JetStream subjects follow `feedeater.<module>.<event>`.
- **Messages are normalized**: everything ingested becomes a `NormalizedMessage` payload with optional content and a `tags` bag.
- **Tags are the primary enrichment mechanism**: modules add key/value tags to messages to assist filtering, routing, and summarization.
- **Narratives are platform-owned**: modules emit narrative updates (summaries, key points, embeddings) that the platform stores and evolves.
- **Summaries live in narratives**: message events are immutable and do not carry summary text.
- **FollowMe panels are module-owned**: modules provide drill-down panel associations for their messages.
- **LLM execution is platform-owned**: modules build prompts and parse results, while the API only runs the model and returns raw responses.

### Non-negotiable interop contract
- **No cross-module database access**: modules must not read or write any other module’s Postgres schema.
- **No direct module-to-module imports/calls**: if a module needs something, it should be expressed as bus events and/or tags.

### Runtime dependencies
- Postgres (pgvector-enabled): platform tables + per-module private schemas
- NATS JetStream: event bus + lightweight job scheduling

