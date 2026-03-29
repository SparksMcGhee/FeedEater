## slack module

Scrapes configured Slack channels and stores raw messages in the module schema `mod_slack`.

### What it stores
Raw Slack message payloads (plus a few convenience columns) in:
- `mod_slack.slack_messages`
- `mod_slack.slack_message_embeddings` (per-message embeddings keyed by `narrative_key`, i.e. channel + thread root)

### Settings (module settings registry)
- `enabled` (boolean)
- `botToken` (secret): Slack bot token with `channels:history` (and `groups:history` if private channels) plus `users:read`
- `channelIds` (string): comma-separated Slack channel IDs
- `lookbackHours` (number)
- `includeThreads` (boolean)
- `excludeBots` (boolean)
- `nonThreadNarrativeTemplate` (string): short label for non-thread channel messages
- `narrativePrompt` / `narrativePromptFallback` (string): system prompts for AI summaries

