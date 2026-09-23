# FeedEater Glossary

Short, stable definitions for core concepts. Intended for humans and AI agents.

## Core Concepts

- **Module**: A plugin under `modules/<name>/` that owns its own settings and private
  Postgres schema (`mod_<name>`). Modules publish events and run jobs.
- **Module Runtime**: The entrypoint (`runtime.entry`) that exposes job handlers for a module.
- **Module Runner**: The per-module process/container (one per module, via compose profiles)
  that boots the module-sdk, declares the module's jobs, and executes them — modules never
  share a process with the platform or each other.
- **Platform Config Registry**: Platform-owned system settings (formerly `modules/system`),
  defined in `packages/core` and surfaced in the UI like a module, but not loaded as a runtime.
- **Settings**: Key/value config stored in Postgres and managed via the API. Secrets are
  encrypted at rest.
- **Event Bus**: NATS JetStream subjects (`feedeater.<module>.<event>`) used for
  module interoperability and realtime streams.
- **NormalizedMessage**: Canonical message payload emitted on the bus. It represents
  any ingested content in a common shape.
- **MessageCreated**: Bus event type that wraps a `NormalizedMessage`.
- **Tag**: A key/value enrichment on a message used for routing, filtering, or
  downstream processing.
- **TagAppended**: Bus event type that adds a tag to an existing message.
- **Narrative**: Platform-owned conversation summary that evolves as new messages arrive (distinct from LLM “context window”).
- **NarrativeSummary**: The short/long summaries and key points stored on a Narrative (not on messages).
- **NarrativeEmbedding**: Vector representation of a Narrative used for semantic recall.
- **NarrativeUpdated**: Bus event type that updates a narrative summary, key points, and embedding.
- **FollowMePanel**: Module-provided drill-down panel association for a message.
- **Realtime Flag**: A transient boolean on `NormalizedMessage` (`realtime: true`)
  indicating a first-time live emission (not replay).
- **AI Summary Endpoint**: Internal API that submits prompts to the configured OpenAI-compatible inference provider (vLLM, TogetherAI, OpenAI, …) and returns a raw response string; modules own prompts and parsing. FeedEater never serves models itself.
- **Hotlink Normalization**: Module-side conversion of source link formats into a common, clickable format in the UI.
- **User**: Identity for human sessions, derived from a validated Teleport JWT
  (`username` claim). In `single-user` Auth Mode all sessions resolve to the fixed
  User `local`.
- **Auth Mode**: Deployment switch (`FEED_AUTH_MODE`): `teleport` validates Teleport
  JWTs on every request; `single-user` disables auth for development/headless use.

## Persistence (Postgres)

- **BusMessage** (`bus_messages`): Archive of `NormalizedMessage` events written by the
  worker archiver. Used for history queries.
- **BusTag** (`bus_tags`): Archive of tags appended to messages.
- **BusNarrative** (`bus_narratives`): Stored narrative summaries with optional embeddings.
- **BusNarrativeMessage** (`bus_narrative_messages`): Association between messages and narratives.
- **JobRun** (`job_runs`): Per-execution record for jobs (queued/running/success/error).
- **JobState** (`job_states`): Last-run and last-error state for each module job.
- **BusReemitDedupe** (`bus_reemit_dedupe`): Dedupe table for startup re-emit so
  only missing messages are re-published to NATS.
- **UserPref** (`user_prefs`): Per-User key/value view preferences (dashboard
  filters, limits) stored in Postgres; managed via `/api/prefs`.

## Jobs and Scheduling

- **Job**: A unit of work declared in `module.json` (scheduled or event-triggered).
- **Queue**: Logical job grouping (usually `mod_<module>`). Used to route jobs to
  module handlers.
- **JobRun Event**: NATS event published to trigger a specific module job.
- **Manual Run**: An API-triggered job run for scheduled jobs only.

## Realtime + Replay

- **Live Stream**: The multiplexed `/api/stream` SSE endpoint that pushes bus, log,
  and narrative events to the web UI in realtime.
- **Stream Hub**: Single per-process NATS subscription per subject that decodes and
  enriches each event once, then fans out to all connected Live Stream clients.
- **History**: Postgres-backed message archive used for lookback and filtering.
- **Startup Re-emit**: On worker start, recent archived messages are re-published
  to NATS to rebuild the live feed.

## Naming Recommendations (Docs + Prompts)

- Prefer **“FeedEater Bus”** or **“Message Bus”** for the unified bus.
- Use **“NormalizedMessage”**, **“MessageCreated”**, and **“TagAppended”** as exact
  protocol names.
- Use **“BusMessage archive”**, **“BusTag archive”**, and **“BusNarrative archive”** for Postgres tables.
- Use **“JobRun”** and **“JobState”** for scheduler metadata.
