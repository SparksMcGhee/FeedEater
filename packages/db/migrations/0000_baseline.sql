-- pgvector powers bus_narratives.embedding below
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bus_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) NOT NULL,
	"sourceModule" text NOT NULL,
	"sourceStream" text,
	"message" text,
	"followMe" text,
	"followMePanel" jsonb,
	"from" text,
	"isDirectMention" boolean DEFAULT false NOT NULL,
	"isDigest" boolean DEFAULT false NOT NULL,
	"isSystemMessage" boolean DEFAULT false NOT NULL,
	"likes" integer,
	"tagsJson" jsonb,
	"rawJson" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bus_narratives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ownerModule" text NOT NULL,
	"sourceKey" text NOT NULL,
	"summaryShort" varchar(128) NOT NULL,
	"summaryLong" text NOT NULL,
	"keyPoints" jsonb NOT NULL,
	"embedding" vector(768),
	"version" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bus_narrative_messages" (
	"narrativeId" uuid NOT NULL,
	"messageId" uuid NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "bus_narrative_messages_narrativeId_messageId_pk" PRIMARY KEY("narrativeId","messageId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bus_reemit_dedupe" (
	"messageId" uuid PRIMARY KEY NOT NULL,
	"lastEmittedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bus_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) NOT NULL,
	"createdByModule" text NOT NULL,
	"messageId" uuid NOT NULL,
	"key" text NOT NULL,
	"valueJson" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"module" text NOT NULL,
	"job" text NOT NULL,
	"queue" text NOT NULL,
	"status" text NOT NULL,
	"triggerType" text NOT NULL,
	"triggerJson" jsonb,
	"metricsJson" jsonb,
	"startedAt" timestamp (3),
	"finishedAt" timestamp (3),
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_states" (
	"id" text PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"job" text NOT NULL,
	"lastRunAt" timestamp (3),
	"lastSuccessAt" timestamp (3),
	"lastErrorAt" timestamp (3),
	"lastError" text,
	"lastMetrics" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Setting" (
	"id" text PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"key" text NOT NULL,
	"isSecret" boolean DEFAULT false NOT NULL,
	"value" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bus_narrative_messages_narrativeId_bus_narratives_id_fk') THEN
    ALTER TABLE "bus_narrative_messages" ADD CONSTRAINT "bus_narrative_messages_narrativeId_bus_narratives_id_fk" FOREIGN KEY ("narrativeId") REFERENCES "public"."bus_narratives"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bus_narrative_messages_messageId_bus_messages_id_fk') THEN
    ALTER TABLE "bus_narrative_messages" ADD CONSTRAINT "bus_narrative_messages_messageId_bus_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."bus_messages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bus_tags_messageId_bus_messages_id_fk') THEN
    ALTER TABLE "bus_tags" ADD CONSTRAINT "bus_tags_messageId_bus_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."bus_messages"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bus_messages_createdAt_idx" ON "bus_messages" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bus_messages_sourceModule_createdAt_idx" ON "bus_messages" USING btree ("sourceModule","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bus_narratives_ownerModule_sourceKey_key" ON "bus_narratives" USING btree ("ownerModule","sourceKey");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bus_narratives_ownerModule_updatedAt_idx" ON "bus_narratives" USING btree ("ownerModule","updatedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bus_narrative_messages_messageId_createdAt_idx" ON "bus_narrative_messages" USING btree ("messageId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bus_tags_messageId_createdAt_idx" ON "bus_tags" USING btree ("messageId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bus_tags_createdByModule_createdAt_idx" ON "bus_tags" USING btree ("createdByModule","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_module_job_createdAt_idx" ON "job_runs" USING btree ("module","job","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_status_createdAt_idx" ON "job_runs" USING btree ("status","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_states_module_job_key" ON "job_states" USING btree ("module","job");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Setting_module_key_key" ON "Setting" USING btree ("module","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Setting_module_idx" ON "Setting" USING btree ("module");