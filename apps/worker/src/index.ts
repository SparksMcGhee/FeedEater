import { connect, StringCodec } from "nats";
import { Pool } from "pg";
import {
  ContextUpdatedEventSchema,
  HealthStatusEventSchema,
  IngestRejectedEventSchema,
  JobRunEventSchema,
  MessageCreatedEventSchema,
  NormalizedMessageSchema,
  healthStatusSubjectFor,
  ingestRejectedSubjectFor,
  createSettingsClient,
  jobSubjectFor,
  subjectFor,
} from "@feedeater/core";
import { discoverModules } from "./modules/discovery.js";
import type { ModuleRuntimeContext, ModuleRuntime } from "@feedeater/module-sdk";
import { loadModuleRuntime } from "./modules/runtime.js";
import { startBusArchiver } from "./bus/archiver.js";

type LogLevel = "debug" | "info" | "warn" | "error";
function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return JSON.stringify({ stringifyError: true });
  }
}

function publishLog(nc: import("nats").NatsConnection, sc: import("nats").StringCodec, level: LogLevel, message: string, meta?: unknown) {
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
        })
      )
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
const DEFAULT_EMBED_DIM = Number(process.env.OLLAMA_EMBED_DIM ?? "4096");
let currentEmbedDim = DEFAULT_EMBED_DIM;

requiredEnv("DATABASE_URL");
const DATABASE_URL = requiredEnv("DATABASE_URL");

const sc = StringCodec();
const JOB_SUBJECT_WILDCARD = "feedeater.jobs.>";
const CONTEXT_SUBJECT_WILDCARD = "feedeater.*.contextUpdated";
const DEFAULT_HEALTH_HEARTBEAT_SECONDS = 60;

type JobTrigger = { type: "schedule" | "manual" | "event"; subject?: string; messageId?: string };
type ModuleHealthState = {
  status: string;
  details?: Record<string, unknown>;
  updatedAt: string;
};

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
  return typeof err === "string" ? err : safeJson(err);
}

function inferModuleNameFromSubject(subject: string): string {
  const parts = String(subject ?? "").split(".");
  if (parts.length < 3 || parts[0] !== "feedeater") return "unknown";
  return parts[1] || "unknown";
}

function publishIngestRejected(params: {
  nc: import("nats").NatsConnection;
  sc: import("nats").StringCodec;
  moduleName: string;
  reason: string;
  timestamp?: string;
  source_subject?: string;
  source_symbol?: string;
  symbol?: string;
  ticker?: string;
  pair?: string;
  error_code?: string;
  stage?: string;
  details?: Record<string, unknown>;
}) {
  const payload = IngestRejectedEventSchema.parse({
    type: "IngestRejected",
    module: params.moduleName,
    timestamp: params.timestamp ?? new Date().toISOString(),
    reason: params.reason,
    ...(params.source_subject ? { source_subject: params.source_subject } : {}),
    ...(params.source_symbol ? { source_symbol: params.source_symbol } : {}),
    ...(params.symbol ? { symbol: params.symbol } : {}),
    ...(params.ticker ? { ticker: params.ticker } : {}),
    ...(params.pair ? { pair: params.pair } : {}),
    ...(params.error_code ? { error_code: params.error_code } : {}),
    ...(params.stage ? { stage: params.stage } : {}),
    ...(params.details ? { details: params.details } : {}),
  });
  params.nc.publish(
    ingestRejectedSubjectFor(params.moduleName),
    params.sc.encode(JSON.stringify(payload))
  );
}

function publishHealthStatus(params: {
  nc: import("nats").NatsConnection;
  sc: import("nats").StringCodec;
  moduleName: string;
  status: string;
  timestamp?: string;
  details?: Record<string, unknown>;
}) {
  const payload = HealthStatusEventSchema.parse({
    type: "HealthStatus",
    module: params.moduleName,
    status: params.status,
    timestamp: params.timestamp ?? new Date().toISOString(),
    ...(params.details ? { details: params.details } : {}),
  });
  params.nc.publish(
    healthStatusSubjectFor(params.moduleName),
    params.sc.encode(JSON.stringify(payload))
  );
}

async function ensureContextStorage(
  db: Pool,
  publish: (level: LogLevel, message: string, meta?: unknown) => void,
  embedDim: number
) {
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err) {
    publish("warn", "failed to ensure pgvector extension", { err: serializeError(err) });
  }

  if (Number.isFinite(embedDim) && embedDim > 0) {
    try {
      await db.query(
        `ALTER TABLE bus_contexts ALTER COLUMN embedding TYPE vector(${embedDim}) USING embedding::vector`
      );
    } catch (err) {
      publish("warn", "failed to ensure bus_contexts embedding dimension", { err: serializeError(err) });
    }
  }

  if (Number.isFinite(embedDim) && embedDim <= 2000) {
    try {
      await db.query(
        `
        CREATE INDEX IF NOT EXISTS bus_context_embedding_idx
        ON bus_contexts USING ivfflat (embedding vector_cosine_ops)
        `
      );
    } catch (err) {
      publish("warn", "failed to ensure bus_contexts embedding index", { err: serializeError(err) });
    }
  } else {
    try {
      await db.query(`DROP INDEX IF EXISTS bus_context_embedding_idx`);
    } catch {
      // ignore
    }
    publish("warn", "skipping bus_contexts ivfflat index (embedding dim > 2000)", { embedDim });
  }
}

async function upsertContext(params: {
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
    INSERT INTO bus_contexts (
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
      version = bus_contexts.version + 1
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
    ]
  );

  const contextId = res.rows?.[0]?.id as string | undefined;
  if (contextId && params.messageId) {
    await params.db.query(
      `
      INSERT INTO bus_context_messages ("contextId", "messageId", "createdAt")
      VALUES ($1, $2, now())
      ON CONFLICT ("contextId", "messageId") DO NOTHING
      `,
      [contextId, params.messageId]
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
    ]
  );

  await params.db.query(
    `
    INSERT INTO job_states (id, module, job, "lastRunAt")
    VALUES ($1, $2, $3, now())
    ON CONFLICT (module, job) DO UPDATE SET "lastRunAt" = EXCLUDED."lastRunAt"
    `,
    [crypto.randomUUID(), params.moduleName, params.jobName]
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
    [params.runId, params.metricsJson ?? null]
  );
  await params.db.query(
    `
    UPDATE job_states
    SET "lastSuccessAt" = now(), "lastErrorAt" = NULL, "lastError" = NULL, "lastRunAt" = now(), "lastMetrics" = $3
    WHERE module = $1 AND job = $2
    `,
    [params.moduleName, params.jobName, params.metricsJson ?? null]
  );
}

async function recordJobError(params: { db: Pool; runId: string; moduleName: string; jobName: string; error: string }) {
  await params.db.query(
    `
    UPDATE job_runs
    SET status = 'error', "updatedAt" = now(), "finishedAt" = now(), error = $2
    WHERE id = $1
    `,
    [params.runId, params.error]
  );
  await params.db.query(
    `
    UPDATE job_states
    SET "lastErrorAt" = now(), "lastError" = $3, "lastRunAt" = now()
    WHERE module = $1 AND job = $2
    `,
    [params.moduleName, params.jobName, params.error]
  );
}

function nextCronTime(cron: string, now: Date): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const min = parts[0] ?? "";
  const hour = parts[1] ?? "";
  const dom = parts[2] ?? "";
  const mon = parts[3] ?? "";
  const dow = parts[4] ?? "";
  if (hour !== "*" || dom !== "*" || mon !== "*" || dow !== "*") return null;

  const next = new Date(now.getTime());
  next.setSeconds(0, 0);

  if (min === "*") {
    next.setMinutes(next.getMinutes() + 1);
    return next;
  }

  const stepMatch = min.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (!Number.isFinite(step) || step <= 0) return null;
    const remainder = next.getMinutes() % step;
    const add = remainder === 0 ? step : step - remainder;
    next.setMinutes(next.getMinutes() + add);
    return next;
  }

  if (/^\d+$/.test(min)) {
    const minute = Number(min);
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
    if (next.getMinutes() < minute) {
      next.setMinutes(minute);
      return next;
    }
    next.setHours(next.getHours() + 1);
    next.setMinutes(minute);
    return next;
  }

  return null;
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
  const subject = jobSubjectFor({ moduleName: params.moduleName, queue: params.queue, job: params.jobName });
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
          const data = (await res.json()) as { settings: Array<{ key: string; value: string | null }> };
          const out: Record<string, unknown> = {};
          for (const s of data.settings) out[s.key] = s.value;
          if (attempt > 1) publishLog(nc, sc, "info", "internal settings fetch recovered", { moduleName, attempt });
          return out;
        } catch (err) {
          const delay = Math.min(5000, 250 * Math.pow(1.6, attempt - 1));
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
    const sysEmbedDimRaw = sysSettings.ollama_embed_dim ?? DEFAULT_EMBED_DIM;
    const sysEmbedDim = Number.isFinite(Number(sysEmbedDimRaw)) ? Number(sysEmbedDimRaw) : DEFAULT_EMBED_DIM;
    currentEmbedDim = sysEmbedDim;
    await ensureContextStorage(db, (level, message, meta) => publishLog(nc, sc, level, message, meta), sysEmbedDim);

    // Start append-only archive consumer (JetStream -> Postgres).
    await startBusArchiver({ nc, db, fetchInternalSettings: fetchSettings });

    const modules = await discoverModules(MODULES_DIR);
    // eslint-disable-next-line no-console
    console.log(`[worker] discovered modules: ${modules.map((m) => m.name).join(", ") || "(none)"}`);

    const runtimeByModule = new Map<string, ModuleRuntime>();
    const moduleHealthByName = new Map<string, ModuleHealthState>();
    const updateModuleHealth = (
      moduleName: string,
      status: string,
      details?: Record<string, unknown>,
      timestamp?: string
    ) => {
      const at = timestamp ?? new Date().toISOString();
      const normalizedDetails = details ?? {};
      moduleHealthByName.set(moduleName, {
        status,
        details: normalizedDetails,
        updatedAt: at,
      });
      publishHealthStatus({
        nc,
        sc,
        moduleName,
        status,
        timestamp: at,
        details: normalizedDetails,
      });
    };
    for (const m of modules) {
      const entry = m.runtime?.entry;
      if (!entry) {
        // eslint-disable-next-line no-console
        console.log(`[worker] module ${m.name} has no runtime.entry; skipping runtime load`);
        updateModuleHealth(m.name, "skipped", { phase: "runtime_missing" });
        continue;
      }
      try {
        const rt = await loadModuleRuntime({ modulesDir: MODULES_DIR, moduleName: m.name, runtimeEntry: entry });
        runtimeByModule.set(m.name, rt);
        updateModuleHealth(m.name, "ready", { phase: "runtime_loaded" });
      } catch (err) {
        publishLog(nc, sc, "error", "module runtime load failed", {
          moduleName: m.name,
          err: serializeError(err),
        });
        updateModuleHealth(m.name, "error", {
          phase: "runtime_load",
          error: serializeError(err),
        });
      }
    }

    const heartbeatSecondsRaw = Number(process.env.FEED_HEALTH_HEARTBEAT_SECONDS ?? DEFAULT_HEALTH_HEARTBEAT_SECONDS);
    const heartbeatSeconds =
      Number.isFinite(heartbeatSecondsRaw) && heartbeatSecondsRaw > 0
        ? heartbeatSecondsRaw
        : DEFAULT_HEALTH_HEARTBEAT_SECONDS;
    const heartbeatTimer = setInterval(() => {
      const heartbeatAt = new Date().toISOString();
      for (const [moduleName, state] of moduleHealthByName.entries()) {
        publishHealthStatus({
          nc,
          sc,
          moduleName,
          status: state.status,
          timestamp: heartbeatAt,
          details: {
            ...(state.details ?? {}),
            heartbeat: true,
            state_updated_at: state.updatedAt,
            heartbeat_interval_seconds: heartbeatSeconds,
          },
        });
      }
    }, heartbeatSeconds * 1000);
    heartbeatTimer.unref?.();

    const baseCtx: Omit<ModuleRuntimeContext, "moduleName" | "getQueue"> = {
      modulesDir: MODULES_DIR,
      db: db as any,
      nats: nc as any,
      sc: sc as any,
      fetchInternalSettings: fetchSettings,
      emitIngestRejected: () => {},
      emitHealthStatus: () => {},
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
      emitIngestRejected: (params) =>
        publishIngestRejected({
          nc,
          sc,
          moduleName,
          ...params,
        }),
      emitHealthStatus: (params) =>
        updateModuleHealth(
          moduleName,
          params.status,
          params.details,
          params.timestamp
        ),
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
            updateModuleHealth(mod.name, "error", {
              phase: "schedule_error",
              job: job.name,
              queue: job.queue,
              error: serializeError(err),
            });
          },
        });
      }
    }

    // NATS → job triggers
    const natsSubs: Array<{ subject: string; queue: string; jobName: string; moduleName: string }> = [];
    for (const mod of modules) {
      for (const j of mod.jobs ?? []) {
        if (j.triggeredBy)
          natsSubs.push({ subject: j.triggeredBy, queue: j.queue, jobName: j.name, moduleName: mod.name });
      }
    }

    for (const s of natsSubs) {
      const sub = nc.subscribe(s.subject);
      (async () => {
        for await (const m of sub) {
          const rawText = sc.decode(m.data);
          try {
            const raw = JSON.parse(rawText) as unknown;
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
            publishIngestRejected({
              nc,
              sc,
              moduleName: s.moduleName,
              reason: "trigger_payload_invalid",
              source_subject: s.subject,
              stage: "job_trigger_enqueue",
              details: {
                error: serializeError(err),
                payload_preview: rawText.slice(0, 500),
                queue: s.queue,
                job: s.jobName,
              },
            });
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
          const trigger: JobTrigger = {
            type: env.trigger.type,
            ...(env.trigger.subject ? { subject: env.trigger.subject } : {}),
            ...(env.trigger.messageId ? { messageId: env.trigger.messageId } : {}),
          };
          await recordJobStart({
            db,
            runId,
            moduleName: env.module,
            queue: env.queue,
            jobName: env.job,
            trigger,
          });

          const rt = runtimeByModule.get(env.module);
          if (!rt) throw new Error(`No runtime loaded for module ${env.module}`);

          const handler = rt.handlers?.[env.queue]?.[env.job];
          if (!handler) throw new Error(`No handler for module=${env.module} queue=${env.queue} job=${env.job}`);

          const ctx = makeCtx(env.module);
          const startedAt = Date.now();
          const result = await handler({ ctx, job: { name: env.job, data: env.data, id: runId } });
          const durationMs = Date.now() - startedAt;
          const metrics =
            result && typeof result === "object" && "metrics" in result && result.metrics
              ? (result.metrics as Record<string, unknown>)
              : {};
          const metricsJson = { durationMs, ...metrics };
          await recordJobSuccess({ db, runId, moduleName: env.module, jobName: env.job, metricsJson });
          updateModuleHealth(env.module, "ok", {
            phase: "job_success",
            queue: env.queue,
            job: env.job,
            run_id: runId,
            trigger_type: env.trigger.type,
            metrics: metricsJson,
          });
        } catch (err) {
          const message = serializeError(err);
          publishLog(nc, sc, "error", "job failed", { err: message });
          try {
            const raw = JSON.parse(sc.decode(m.data)) as unknown;
            const env = JobRunEventSchema.safeParse(raw);
            if (env.success) {
              const runId = env.data.runId ?? crypto.randomUUID();
              await recordJobError({ db, runId, moduleName: env.data.module, jobName: env.data.job, error: message });
              updateModuleHealth(env.data.module, "error", {
                phase: "job_error",
                queue: env.data.queue,
                job: env.data.job,
                run_id: runId,
                trigger_type: env.data.trigger.type,
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

    const contextSub = nc.subscribe(CONTEXT_SUBJECT_WILDCARD);
    (async () => {
      for await (const m of contextSub) {
        const rawText = sc.decode(m.data);
        try {
          const raw = JSON.parse(rawText) as unknown;
          const env = ContextUpdatedEventSchema.parse(raw);
          await upsertContext({
            db,
            ownerModule: env.context.ownerModule,
            summaryShort: env.context.summaryShort,
            summaryLong: env.context.summaryLong,
            keyPoints: env.context.keyPoints ?? [],
            ...(env.context.sourceKey ? { sourceKey: env.context.sourceKey } : {}),
            ...(env.context.embedding ? { embedding: env.context.embedding } : {}),
            ...(env.messageId ? { messageId: env.messageId } : {}),
          });
        } catch (err) {
          publishLog(nc, sc, "warn", "failed to apply context update", { err: serializeError(err) });
          publishIngestRejected({
            nc,
            sc,
            moduleName: inferModuleNameFromSubject((m as any).subject),
            reason: "context_update_invalid",
            source_subject: (m as any).subject,
            stage: "context_apply",
            details: {
              error: serializeError(err),
              payload_preview: rawText.slice(0, 500),
            },
          });
        }
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[worker] context subscription loop crashed", err);
      publishLog(nc, sc, "error", "context subscription loop crashed", err);
    });

    // Re-emit Postgres history into NATS for dashboard lookback window.
    const sysSettings2 = await fetchSettings("system");
    const lookbackMinutesRaw = sysSettings2.dashboard_bus_history_minutes;
    const parsedLookbackMinutes =
      lookbackMinutesRaw === null || lookbackMinutesRaw === undefined ? NaN : Number(String(lookbackMinutesRaw).trim());
    const lookbackMinutes = Number.isFinite(parsedLookbackMinutes) && parsedLookbackMinutes >= 0 ? parsedLookbackMinutes : 60;

    await db.query(
      `
      DELETE FROM bus_reemit_dedupe
      WHERE "lastEmittedAt" < (now() - ($1 * INTERVAL '1 minute'))
      `,
      [lookbackMinutes]
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
      [since]
    );

    for (const row of res.rows as Array<{ id: string; rawJson: unknown }>) {
      try {
        const msg = NormalizedMessageSchema.parse(row.rawJson);
        const event = MessageCreatedEventSchema.parse({
          type: "MessageCreated",
          message: { ...msg, realtime: false },
        });
        nc.publish(subjectFor(msg.source.module, "messageCreated"), sc.encode(JSON.stringify(event)));
        await db.query(
          `
          INSERT INTO bus_reemit_dedupe ("messageId", "lastEmittedAt")
          VALUES ($1, now())
          ON CONFLICT ("messageId") DO UPDATE SET "lastEmittedAt" = EXCLUDED."lastEmittedAt"
          `,
          [row.id]
        );
      } catch (err) {
        publishLog(nc, sc, "warn", "failed to re-emit bus history", { err: serializeError(err), messageId: row.id });
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
