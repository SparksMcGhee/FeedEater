import {
  createSettingsClient,
  JobRunEventSchema,
  jobSubjectFor,
  MessageCreatedEventSchema,
  NarrativeUpdatedEventSchema,
  NormalizedMessageSchema,
  subjectFor,
} from "@feedeater/core";
import type { ModuleRuntime, ModuleRuntimeContext } from "@feedeater/module-sdk";
import { slackSourceIdToBusMessageId } from "@feedeater/module-slack";
import { connect, StringCodec } from "nats";
import { Pool } from "pg";
import { startBusArchiver } from "./bus/archiver.js";
import { discoverModules } from "./modules/discovery.js";
import { loadModuleRuntime } from "./modules/runtime.js";
import { nextCronTime } from "./scheduler/cron.js";

type LogLevel = "debug" | "info" | "warn" | "error";
function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return JSON.stringify({ stringifyError: true });
  }
}

function publishLog(
  nc: import("nats").NatsConnection,
  sc: import("nats").StringCodec,
  level: LogLevel,
  message: string,
  meta?: unknown,
) {
  try {
    nc.publish(
      "feedeater.worker.log",
      sc.encode(
        safeJson({
          level,
          module: "worker",
          source: "process",
          at: new Date().toISOString(),
          message,
          meta,
        }),
      ),
    );
  } catch {
    // ignore
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const NATS_URL = requiredEnv("NATS_URL");
const MODULES_DIR = process.env.FEED_MODULES_DIR ?? "/app/modules";
const API_BASE_URL = process.env.FEED_API_BASE_URL ?? "http://localhost:4000";
const INTERNAL_TOKEN = requiredEnv("FEED_INTERNAL_TOKEN");
const DEFAULT_EMBED_DIM = Number(process.env.AI_EMBED_DIM ?? process.env.OLLAMA_EMBED_DIM ?? "768");
let currentEmbedDim = DEFAULT_EMBED_DIM;

requiredEnv("DATABASE_URL");
const DATABASE_URL = requiredEnv("DATABASE_URL");

const sc = StringCodec();
const JOB_SUBJECT_WILDCARD = "feedeater.jobs.>";
const NARRATIVE_SUBJECT_WILDCARD = "feedeater.*.narrativeUpdated";

type JobTrigger = { type: "schedule" | "manual" | "event"; subject?: string; messageId?: string };

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
  return typeof err === "string" ? err : safeJson(err);
}

async function ensureNarrativeStorage(
  db: Pool,
  publish: (level: LogLevel, message: string, meta?: unknown) => void,
  embedDim: number,
) {
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err) {
    publish("warn", "failed to ensure pgvector extension", { err: serializeError(err) });
  }

  if (Number.isFinite(embedDim) && embedDim > 0) {
    try {
      await db.query(
        `ALTER TABLE bus_narratives ADD COLUMN IF NOT EXISTS embedding vector(${embedDim})`,
      );
      await db.query(
        `ALTER TABLE bus_narratives ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`,
      );
    } catch (err) {
      publish("warn", "failed to ensure bus_narratives embedding dimension", {
        err: serializeError(err),
      });
    }
  }

  if (Number.isFinite(embedDim) && embedDim <= 2000) {
    try {
      await db.query(
        `
        CREATE INDEX IF NOT EXISTS bus_narrative_embedding_idx
        ON bus_narratives USING ivfflat (embedding vector_cosine_ops)
        `,
      );
    } catch (err) {
      publish("warn", "failed to ensure bus_narratives embedding index", {
        err: serializeError(err),
      });
    }
  } else {
    try {
      await db.query(`DROP INDEX IF EXISTS bus_narrative_embedding_idx`);
    } catch {
      // ignore
    }
    publish("warn", "skipping bus_narratives ivfflat index (embedding dim > 2000)", { embedDim });
  }
}

async function upsertNarrative(params: {
  db: Pool;
  ownerModule: string;
  sourceKey?: string;
  summaryShort: string;
  summaryLong: string;
  keyPoints: string[];
  embedding?: number[];
  messageId?: string;
}) {
  const summaryShort = params.summaryShort.slice(0, 128);
  const sourceKey = params.sourceKey ?? params.messageId ?? crypto.randomUUID();
  const validEmbedding =
    params.embedding &&
    params.embedding.length > 0 &&
    (!Number.isFinite(currentEmbedDim) || params.embedding.length === currentEmbedDim);
  const embeddingValue = validEmbedding ? `[${params.embedding!.join(",")}]` : "";

  const res = await params.db.query(
    `
    INSERT INTO bus_narratives (
      id, "ownerModule", "sourceKey", "summaryShort", "summaryLong", "keyPoints", embedding, version, "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      NULLIF($7, '')::vector,
      1, now(), now()
    )
    ON CONFLICT ("ownerModule", "sourceKey") DO UPDATE SET
      "summaryShort" = EXCLUDED."summaryShort",
      "summaryLong" = EXCLUDED."summaryLong",
      "keyPoints" = EXCLUDED."keyPoints",
      embedding = EXCLUDED.embedding,
      "updatedAt" = now(),
      version = bus_narratives.version + 1
    RETURNING id
    `,
    [
      crypto.randomUUID(),
      params.ownerModule,
      sourceKey,
      summaryShort,
      params.summaryLong,
      params.keyPoints,
      embeddingValue,
    ],
  );

  const narrativeId = res.rows?.[0]?.id as string | undefined;
  if (!narrativeId) return;

  if (params.ownerModule === "slack") {
    const colon = sourceKey.indexOf(":");
    if (colon > 0) {
      const channelId = sourceKey.slice(0, colon);
      const threadRootTs = sourceKey.slice(colon + 1);
      const slackRows = await params.db.query(
        `
        SELECT id FROM mod_slack.slack_messages
        WHERE channel_id = $1 AND (
          (thread_ts IS NULL AND slack_ts = $2)
          OR (thread_ts = $2)
        )
        `,
        [channelId, threadRootTs],
      );
      for (const r of slackRows.rows ?? []) {
        const busId = slackSourceIdToBusMessageId(String((r as { id: string }).id));
        await params.db.query(
          `
          INSERT INTO bus_narrative_messages ("narrativeId", "messageId", "createdAt")
          VALUES ($1, $2, now())
          ON CONFLICT ("narrativeId", "messageId") DO NOTHING
          `,
          [narrativeId, busId],
        );
      }
    }
  }

  if (params.messageId) {
    await params.db.query(
      `
      INSERT INTO bus_narrative_messages ("narrativeId", "messageId", "createdAt")
      VALUES ($1, $2, now())
      ON CONFLICT ("narrativeId", "messageId") DO NOTHING
      `,
      [narrativeId, params.messageId],
    );
  }
}

async function recordJobStart(params: {
  db: Pool;
  runId: string;
  moduleName: string;
  queue: string;
  jobName: string;
  trigger: JobTrigger;
}) {
  const triggerJson = params.trigger ?? null;
  await params.db.query(
    `
    INSERT INTO job_runs (
      id, "createdAt", "updatedAt",
      module, job, queue,
      status, "triggerType", "triggerJson",
      "startedAt"
    ) VALUES (
      $1, now(), now(),
      $2, $3, $4,
      'running', $5, $6,
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      status = 'running',
      "updatedAt" = now(),
      "startedAt" = now()
    `,
    [
      params.runId,
      params.moduleName,
      params.jobName,
      params.queue,
      params.trigger.type,
      triggerJson,
    ],
  );

  await params.db.query(
    `
    INSERT INTO job_states (id, module, job, "lastRunAt")
    VALUES ($1, $2, $3, now())
    ON CONFLICT (module, job) DO UPDATE SET "lastRunAt" = EXCLUDED."lastRunAt"
    `,
    [crypto.randomUUID(), params.moduleName, params.jobName],
  );
}

async function recordJobSuccess(params: {
  db: Pool;
  runId: string;
  moduleName: string;
  jobName: string;
  metricsJson?: Record<string, unknown>;
}) {
  await params.db.query(
    `
    UPDATE job_runs
    SET status = 'success', "updatedAt" = now(), "finishedAt" = now(), error = NULL, "metricsJson" = $2
    WHERE id = $1
    `,
    [params.runId, params.metricsJson ?? null],
  );
  await params.db.query(
    `
    UPDATE job_states
    SET "lastSuccessAt" = now(), "lastErrorAt" = NULL, "lastError" = NULL, "lastRunAt" = now(), "lastMetrics" = $3
    WHERE module = $1 AND job = $2
    `,
    [params.moduleName, params.jobName, params.metricsJson ?? null],
  );
}

async function recordJobError(params: {
  db: Pool;
  runId: string;
  moduleName: string;
  jobName: string;
  error: string;
}) {
  await params.db.query(
    `
    UPDATE job_runs
    SET status = 'error', "updatedAt" = now(), "finishedAt" = now(), error = $2
    WHERE id = $1
    `,
    [params.runId, params.error],
  );
  await params.db.query(
    `
    UPDATE job_states
    SET "lastErrorAt" = now(), "lastError" = $3, "lastRunAt" = now()
    WHERE module = $1 AND job = $2
    `,
    [params.moduleName, params.jobName, params.error],
  );
}

function scheduleCronJob(params: {
  schedule: string;
  onTick: (nextAt: Date) => Promise<void> | void;
  onError: (err: unknown) => void;
}) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (cancelled) return;
    try {
      const nextAt = nextCronTime(params.schedule, new Date());
      if (!nextAt) throw new Error(`Unsupported cron pattern: ${params.schedule}`);
      const delay = Math.max(0, nextAt.getTime() - Date.now());
      timer = setTimeout(async () => {
        try {
          await params.onTick(nextAt);
        } catch (err) {
          params.onError(err);
        } finally {
          scheduleNext();
        }
      }, delay);
    } catch (err) {
      params.onError(err);
    }
  };

  scheduleNext();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

async function publishJobEvent(params: {
  nc: import("nats").NatsConnection;
  sc: import("nats").StringCodec;
  moduleName: string;
  queue: string;
  jobName: string;
  trigger: JobTrigger;
  runId?: string;
  data?: unknown;
}) {
  const payload = JobRunEventSchema.parse({
    type: "JobRun",
    module: params.moduleName,
    queue: params.queue,
    job: params.jobName,
    requestedAt: new Date().toISOString(),
    runId: params.runId,
    trigger: params.trigger,
    data: params.data,
  });
  const subject = jobSubjectFor({
    moduleName: params.moduleName,
    queue: params.queue,
    job: params.jobName,
  });
  params.nc.publish(subject, params.sc.encode(JSON.stringify(payload)));
}

async function main() {
  const nc = await connect({ servers: NATS_URL });
  // eslint-disable-next-line no-console
  console.log("[worker] connected to nats");

  try {
    const db = new Pool({ connectionString: DATABASE_URL });
    const settingsClient = createSettingsClient({ apiBaseUrl: API_BASE_URL });
    const apiBase = API_BASE_URL.replace(/\/+$/, "");
    const fetchSettings = async (moduleName: string) => {
      const url = `${apiBase}/api/internal/settings/${encodeURIComponent(moduleName)}`;
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          const res = await fetch(url, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
          if (!res.ok) throw new Error(`internal settings fetch failed (${res.status})`);
          const data = (await res.json()) as {
            settings: Array<{ key: string; value: string | null }>;
          };
          const out: Record<string, unknown> = {};
          for (const s of data.settings) out[s.key] = s.value;
          if (attempt > 1)
            publishLog(nc, sc, "info", "internal settings fetch recovered", {
              moduleName,
              attempt,
            });
          return out;
        } catch (err) {
          const delay = Math.min(5000, 250 * 1.6 ** (attempt - 1));
          publishLog(nc, sc, "warn", "internal settings fetch failed; retrying", {
            moduleName,
            attempt,
            delayMs: Math.floor(delay),
            err: err instanceof Error ? { name: err.name, message: err.message } : err,
          });
          await sleep(delay);
        }
      }
    };

    const sysSettings = await fetchSettings("system");
    const sysEmbedDimRaw =
      sysSettings.ai_embed_dim ?? sysSettings.ollama_embed_dim ?? DEFAULT_EMBED_DIM;
    const sysEmbedDim = Number.isFinite(Number(sysEmbedDimRaw))
      ? Number(sysEmbedDimRaw)
      : DEFAULT_EMBED_DIM;
    currentEmbedDim = sysEmbedDim;
    await ensureNarrativeStorage(
      db,
      (level, message, meta) => publishLog(nc, sc, level, message, meta),
      sysEmbedDim,
    );

    // Start append-only archive consumer (JetStream -> Postgres).
    await startBusArchiver({ nc, db, fetchInternalSettings: fetchSettings });

    const modules = await discoverModules(MODULES_DIR);
    // eslint-disable-next-line no-console
    console.log(
      `[worker] discovered modules: ${modules.map((m) => m.name).join(", ") || "(none)"}`,
    );

    const runtimeByModule = new Map<string, ModuleRuntime>();
    for (const m of modules) {
      const entry = m.runtime?.entry;
      if (!entry) {
        // eslint-disable-next-line no-console
        console.log(`[worker] module ${m.name} has no runtime.entry; skipping runtime load`);
        continue;
      }
      const rt = await loadModuleRuntime({
        modulesDir: MODULES_DIR,
        moduleName: m.name,
        runtimeEntry: entry,
      });
      runtimeByModule.set(m.name, rt);
    }

    const baseCtx: Omit<ModuleRuntimeContext, "moduleName" | "getQueue"> = {
      modulesDir: MODULES_DIR,
      db: db as any,
      nats: nc as any,
      sc: sc as any,
      fetchInternalSettings: fetchSettings,
    };

    const makeCtx = (moduleName: string): ModuleRuntimeContext => ({
      ...(baseCtx as any),
      moduleName,
      getQueue: (queueName: string) =>
        ({
          add: async (name: string, data: unknown) => {
            await publishJobEvent({
              nc,
              sc,
              moduleName,
              queue: queueName,
              jobName: name,
              trigger: { type: "event", subject: "internal" },
              data,
            });
          },
        }) as any,
    });

    // Schedule repeat jobs declared by modules.
    for (const mod of modules) {
      for (const job of mod.jobs ?? []) {
        if (!job.schedule) continue;
        scheduleCronJob({
          schedule: job.schedule,
          onTick: async (nextAt) => {
            publishLog(nc, sc, "debug", "cron fired", {
              module: mod.name,
              job: job.name,
              queue: job.queue,
              nextAt: nextAt.toISOString(),
            });
            await publishJobEvent({
              nc,
              sc,
              moduleName: mod.name,
              queue: job.queue,
              jobName: job.name,
              trigger: { type: "schedule" },
            });
          },
          onError: (err) => {
            publishLog(nc, sc, "error", "cron schedule failed", {
              module: mod.name,
              job: job.name,
              queue: job.queue,
              err: serializeError(err),
            });
          },
        });
      }
    }

    // NATS → job triggers
    const natsSubs: Array<{ subject: string; queue: string; jobName: string; moduleName: string }> =
      [];
    for (const mod of modules) {
      for (const j of mod.jobs ?? []) {
        if (j.triggeredBy)
          natsSubs.push({
            subject: j.triggeredBy,
            queue: j.queue,
            jobName: j.name,
            moduleName: mod.name,
          });
      }
    }

    for (const s of natsSubs) {
      const sub = nc.subscribe(s.subject);
      (async () => {
        for await (const m of sub) {
          try {
            const raw = JSON.parse(sc.decode(m.data)) as unknown;
            // Support both payload shapes:
            // - NormalizedMessage
            // - { type: "MessageCreated", message: NormalizedMessage }
            const msg = (() => {
              const env = MessageCreatedEventSchema.safeParse(raw);
              if (env.success) return env.data.message;
              return NormalizedMessageSchema.parse(raw);
            })();
            await publishJobEvent({
              nc,
              sc,
              moduleName: s.moduleName,
              queue: s.queue,
              jobName: s.jobName,
              trigger: { type: "event", subject: s.subject, messageId: msg.id },
              data: { trigger: { subject: s.subject, messageId: msg.id } },
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[worker] failed to enqueue triggered job", err);
            publishLog(nc, sc, "error", "failed to enqueue triggered job", err);
          }
        }
      })().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[worker] subscription loop crashed", err);
        publishLog(nc, sc, "error", "subscription loop crashed", err);
      });
    }

    // Job dispatchers (NATS-based).
    const jobSub = nc.subscribe(JOB_SUBJECT_WILDCARD);
    (async () => {
      for await (const m of jobSub) {
        try {
          const raw = JSON.parse(sc.decode(m.data)) as unknown;
          const env = JobRunEventSchema.parse(raw);
          const runId = env.runId ?? crypto.randomUUID();
          await recordJobStart({
            db,
            runId,
            moduleName: env.module,
            queue: env.queue,
            jobName: env.job,
            trigger: {
              type: env.trigger.type,
              ...(env.trigger.subject !== undefined ? { subject: env.trigger.subject } : {}),
              ...(env.trigger.messageId !== undefined ? { messageId: env.trigger.messageId } : {}),
            },
          });

          const rt = runtimeByModule.get(env.module);
          if (!rt) throw new Error(`No runtime loaded for module ${env.module}`);

          const handler = rt.handlers?.[env.queue]?.[env.job];
          if (!handler)
            throw new Error(
              `No handler for module=${env.module} queue=${env.queue} job=${env.job}`,
            );

          const ctx = makeCtx(env.module);
          const startedAt = Date.now();
          const result = await handler({ ctx, job: { name: env.job, data: env.data, id: runId } });
          const durationMs = Date.now() - startedAt;
          const metrics =
            result && typeof result === "object" && "metrics" in result && result.metrics
              ? (result.metrics as Record<string, unknown>)
              : {};
          const metricsJson = { durationMs, ...metrics };
          await recordJobSuccess({
            db,
            runId,
            moduleName: env.module,
            jobName: env.job,
            metricsJson,
          });
        } catch (err) {
          const message = serializeError(err);
          publishLog(nc, sc, "error", "job failed", { err: message });
          try {
            const raw = JSON.parse(sc.decode(m.data)) as unknown;
            const env = JobRunEventSchema.safeParse(raw);
            if (env.success) {
              const runId = env.data.runId ?? crypto.randomUUID();
              await recordJobError({
                db,
                runId,
                moduleName: env.data.module,
                jobName: env.data.job,
                error: message,
              });
            }
          } catch {
            // ignore
          }
        }
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[worker] job subscription loop crashed", err);
      publishLog(nc, sc, "error", "job subscription loop crashed", err);
    });

    const narrativeSub = nc.subscribe(NARRATIVE_SUBJECT_WILDCARD);
    (async () => {
      for await (const m of narrativeSub) {
        try {
          const raw = JSON.parse(sc.decode(m.data)) as unknown;
          const env = NarrativeUpdatedEventSchema.parse(raw);
          await upsertNarrative({
            db,
            ownerModule: env.narrative.ownerModule,
            ...(env.narrative.sourceKey !== undefined
              ? { sourceKey: env.narrative.sourceKey }
              : {}),
            summaryShort: env.narrative.summaryShort,
            summaryLong: env.narrative.summaryLong,
            keyPoints: env.narrative.keyPoints ?? [],
            ...(env.narrative.embedding !== undefined
              ? { embedding: env.narrative.embedding }
              : {}),
            ...(env.messageId !== undefined ? { messageId: env.messageId } : {}),
          });
        } catch (err) {
          publishLog(nc, sc, "warn", "failed to apply narrative update", {
            err: serializeError(err),
          });
        }
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[worker] narrative subscription loop crashed", err);
      publishLog(nc, sc, "error", "narrative subscription loop crashed", err);
    });

    // Re-emit Postgres history into NATS for dashboard lookback window.
    const sysSettings2 = await fetchSettings("system");
    const lookbackMinutesRaw = sysSettings2.dashboard_bus_history_minutes;
    const parsedLookbackMinutes =
      lookbackMinutesRaw === null || lookbackMinutesRaw === undefined
        ? NaN
        : Number(String(lookbackMinutesRaw).trim());
    const lookbackMinutes =
      Number.isFinite(parsedLookbackMinutes) && parsedLookbackMinutes >= 0
        ? parsedLookbackMinutes
        : 60;

    await db.query(
      `
      DELETE FROM bus_reemit_dedupe
      WHERE "lastEmittedAt" < (now() - ($1 * INTERVAL '1 minute'))
      `,
      [lookbackMinutes],
    );

    const since = new Date(Date.now() - lookbackMinutes * 60_000);
    const res = await db.query(
      `
      SELECT m.id, m."rawJson"
      FROM bus_messages m
      LEFT JOIN bus_reemit_dedupe d ON d."messageId" = m.id
      WHERE m."createdAt" >= $1 AND d."messageId" IS NULL
      ORDER BY m."createdAt" ASC
      `,
      [since],
    );

    for (const row of res.rows as Array<{ id: string; rawJson: unknown }>) {
      try {
        const msg = NormalizedMessageSchema.parse(row.rawJson);
        const event = MessageCreatedEventSchema.parse({
          type: "MessageCreated",
          message: { ...msg, realtime: false },
        });
        nc.publish(
          subjectFor(msg.source.module, "messageCreated"),
          sc.encode(JSON.stringify(event)),
        );
        await db.query(
          `
          INSERT INTO bus_reemit_dedupe ("messageId", "lastEmittedAt")
          VALUES ($1, now())
          ON CONFLICT ("messageId") DO UPDATE SET "lastEmittedAt" = EXCLUDED."lastEmittedAt"
          `,
          [row.id],
        );
      } catch (err) {
        publishLog(nc, sc, "warn", "failed to re-emit bus history", {
          err: serializeError(err),
          messageId: row.id,
        });
      }
    }

    // Keep the legacy settings client referenced to avoid tree-shaking issues in some bundlers.
    void settingsClient;
  } catch (err) {
    publishLog(nc, sc, "error", "fatal", err);
    throw err;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal", err);
  process.exit(1);
});
