import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

// timestamp(3) without timezone — matches the DDL the previous Prisma schema generated.
const ts = (name: string) => timestamp(name, { withTimezone: false, mode: "date", precision: 3 });

export const setting = pgTable(
  "Setting",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    module: text("module").notNull(),
    key: text("key").notNull(),
    isSecret: boolean("isSecret").default(false).notNull(),
    value: text("value").notNull(),
    createdAt: ts("createdAt").defaultNow().notNull(),
    updatedAt: ts("updatedAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("Setting_module_key_key").on(t.module, t.key),
    index("Setting_module_idx").on(t.module),
  ],
);

export const busMessage = pgTable(
  "bus_messages",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: ts("createdAt").notNull(),
    sourceModule: text("sourceModule").notNull(),
    sourceStream: text("sourceStream"),
    message: text("message"),
    followMe: text("followMe"),
    followMePanel: jsonb("followMePanel"),
    from: text("from"),
    isDirectMention: boolean("isDirectMention").default(false).notNull(),
    isDigest: boolean("isDigest").default(false).notNull(),
    isSystemMessage: boolean("isSystemMessage").default(false).notNull(),
    likes: integer("likes"),
    tagsJson: jsonb("tagsJson"),
    rawJson: jsonb("rawJson").notNull(),
  },
  (t) => [
    index("bus_messages_createdAt_idx").on(t.createdAt),
    index("bus_messages_sourceModule_createdAt_idx").on(t.sourceModule, t.createdAt),
  ],
);

export const busTag = pgTable(
  "bus_tags",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: ts("createdAt").notNull(),
    createdByModule: text("createdByModule").notNull(),
    messageId: uuid("messageId")
      .notNull()
      .references(() => busMessage.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    valueJson: jsonb("valueJson").notNull(),
  },
  (t) => [
    index("bus_tags_messageId_createdAt_idx").on(t.messageId, t.createdAt),
    index("bus_tags_createdByModule_createdAt_idx").on(t.createdByModule, t.createdAt),
  ],
);

export const busNarrative = pgTable(
  "bus_narratives",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerModule: text("ownerModule").notNull(),
    sourceKey: text("sourceKey").notNull(),
    summaryShort: varchar("summaryShort", { length: 128 }).notNull(),
    summaryLong: text("summaryLong").notNull(),
    keyPoints: jsonb("keyPoints").notNull(),
    embedding: vector("embedding", { dimensions: 768 }),
    version: integer("version").default(1).notNull(),
    createdAt: ts("createdAt").defaultNow().notNull(),
    updatedAt: ts("updatedAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bus_narratives_ownerModule_sourceKey_key").on(t.ownerModule, t.sourceKey),
    index("bus_narratives_ownerModule_updatedAt_idx").on(t.ownerModule, t.updatedAt),
  ],
);

export const busNarrativeMessage = pgTable(
  "bus_narrative_messages",
  {
    narrativeId: uuid("narrativeId")
      .notNull()
      .references(() => busNarrative.id, { onDelete: "cascade" }),
    messageId: uuid("messageId")
      .notNull()
      .references(() => busMessage.id, { onDelete: "cascade" }),
    createdAt: ts("createdAt").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.narrativeId, t.messageId] }),
    index("bus_narrative_messages_messageId_createdAt_idx").on(t.messageId, t.createdAt),
  ],
);

export const jobRun = pgTable(
  "job_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: ts("createdAt").defaultNow().notNull(),
    updatedAt: ts("updatedAt").defaultNow().notNull(),
    module: text("module").notNull(),
    job: text("job").notNull(),
    queue: text("queue").notNull(),
    status: text("status").notNull(),
    triggerType: text("triggerType").notNull(),
    triggerJson: jsonb("triggerJson"),
    metricsJson: jsonb("metricsJson"),
    startedAt: ts("startedAt"),
    finishedAt: ts("finishedAt"),
    error: text("error"),
  },
  (t) => [
    index("job_runs_module_job_createdAt_idx").on(t.module, t.job, t.createdAt),
    index("job_runs_status_createdAt_idx").on(t.status, t.createdAt),
  ],
);

export const jobState = pgTable(
  "job_states",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    module: text("module").notNull(),
    job: text("job").notNull(),
    lastRunAt: ts("lastRunAt"),
    lastSuccessAt: ts("lastSuccessAt"),
    lastErrorAt: ts("lastErrorAt"),
    lastError: text("lastError"),
    lastMetrics: jsonb("lastMetrics"),
  },
  (t) => [uniqueIndex("job_states_module_job_key").on(t.module, t.job)],
);

export const busReemitDedupe = pgTable("bus_reemit_dedupe", {
  messageId: uuid("messageId").primaryKey(),
  lastEmittedAt: ts("lastEmittedAt")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const busMessageRelations = relations(busMessage, ({ many }) => ({
  tags: many(busTag),
  narratives: many(busNarrativeMessage),
}));

export const busTagRelations = relations(busTag, ({ one }) => ({
  message: one(busMessage, { fields: [busTag.messageId], references: [busMessage.id] }),
}));

export const busNarrativeRelations = relations(busNarrative, ({ many }) => ({
  messages: many(busNarrativeMessage),
}));

export const busNarrativeMessageRelations = relations(busNarrativeMessage, ({ one }) => ({
  narrative: one(busNarrative, {
    fields: [busNarrativeMessage.narrativeId],
    references: [busNarrative.id],
  }),
  message: one(busMessage, {
    fields: [busNarrativeMessage.messageId],
    references: [busMessage.id],
  }),
}));
