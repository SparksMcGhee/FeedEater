-- FeedEater: rename domain tables and columns from context → narrative.
-- Run once against your Postgres after pulling the Narrative rename (before or with app deploy).

-- Platform bus tables
ALTER TABLE IF EXISTS bus_contexts RENAME TO bus_narratives;

ALTER TABLE IF EXISTS bus_context_messages RENAME TO bus_narrative_messages;

ALTER TABLE bus_narrative_messages RENAME COLUMN "contextId" TO "narrativeId";

ALTER INDEX IF EXISTS bus_context_embedding_idx RENAME TO bus_narrative_embedding_idx;

-- Slack module
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mod_slack' AND table_name = 'slack_message_embeddings' AND column_name = 'context_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'mod_slack' AND table_name = 'slack_message_embeddings' AND column_name = 'narrative_key'
  ) THEN
    ALTER TABLE mod_slack.slack_message_embeddings RENAME COLUMN context_key TO narrative_key;
  END IF;
END $$;

ALTER INDEX IF EXISTS slack_message_embeddings_context_idx RENAME TO slack_message_embeddings_narrative_idx;

-- System settings keys (preserves values)
UPDATE "Setting" SET key = 'dashboard_narratives_history_minutes' WHERE module = 'system' AND key = 'dashboard_contexts_history_minutes';
UPDATE "Setting" SET key = 'dashboard_narratives_limit' WHERE module = 'system' AND key = 'dashboard_contexts_limit';
UPDATE "Setting" SET key = 'dashboard_narratives_filter_module' WHERE module = 'system' AND key = 'dashboard_contexts_filter_module';
UPDATE "Setting" SET key = 'dashboard_narratives_search' WHERE module = 'system' AND key = 'dashboard_contexts_search';
UPDATE "Setting" SET key = 'narrative_top_k' WHERE module = 'system' AND key = 'context_top_k';

UPDATE "Setting" SET key = 'nonThreadNarrativeTemplate' WHERE module = 'slack' AND key = 'nonThreadContextTemplate';
UPDATE "Setting" SET key = 'narrativePrompt' WHERE module = 'slack' AND key = 'contextPrompt';
UPDATE "Setting" SET key = 'narrativePromptFallback' WHERE module = 'slack' AND key = 'contextPromptFallback';

-- Job name in scheduler state (optional; historical job_runs rows unchanged)
UPDATE job_states SET job = 'updateNarratives' WHERE module = 'slack' AND job = 'updateContexts';
