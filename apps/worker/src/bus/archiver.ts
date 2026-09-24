import { BusEventSchema } from "@feedeater/core";
import type { NatsConnection } from "nats";
import { consumerOpts, RetentionPolicy, StorageType, StringCodec } from "nats";
import type { Pool } from "pg";

const STREAM_NAME = "feedeater_bus";
const DURABLE_NAME = "feedeater_archiver";
const SUBJECT_MESSAGES = "feedeater.*.messageCreated";
const SUBJECT_TAGS = "feedeater.tags.appended";

export async function startBusArchiver(params: {
  nc: NatsConnection;
  db: Pool;
  fetchInternalSettings: (moduleName: string) => Promise<Record<string, unknown>>;
}) {
  const sc = StringCodec();
  const publishLog = (level: "info" | "warn" | "error", message: string, meta?: unknown) => {
    try {
      params.nc.publish(
        "feedeater.worker.log",
        sc.encode(
          JSON.stringify({
            level,
            module: "worker",
            source: "archiver",
            at: new Date().toISOString(),
            message,
            meta,
          }),
        ),
      );
    } catch {
      // ignore
    }
  };

  // Retention (MaxAge) is configurable via system settings.
  const sys = await params.fetchInternalSettings("system");
  const maxAgeSecondsRaw = sys.jetstream_max_age_seconds;
  const defaultMaxAgeSeconds = 30 * 24 * 3600;
  const parsedMaxAgeSeconds =
    maxAgeSecondsRaw === null || maxAgeSecondsRaw === undefined
      ? NaN
      : Number(String(maxAgeSecondsRaw).trim());
  const maxAgeSeconds =
    Number.isFinite(parsedMaxAgeSeconds) && parsedMaxAgeSeconds >= 0.1
      ? parsedMaxAgeSeconds
      : defaultMaxAgeSeconds;
  // JetStream max_age is in nanoseconds and must be >= 100ms.
  // Keep as a JS number (avoid bigint edge cases) — 30d is well within Number.MAX_SAFE_INTEGER.
  const maxAgeNanos = Math.max(100_000_000, Math.floor(maxAgeSeconds * 1_000_000_000));

  const jsm = await params.nc.jetstreamManager();
  publishLog("info", "archiver starting (jetstream retention)", {
    maxAgeSecondsRaw,
    maxAgeSeconds,
    maxAgeNanos,
  });
  try {
    await jsm.streams.info(STREAM_NAME);
    const cfg = {
      name: STREAM_NAME,
      subjects: [SUBJECT_MESSAGES, SUBJECT_TAGS],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: maxAgeNanos,
    } as const;
    // eslint-disable-next-line no-console
    console.log("[archiver] updating stream", {
      name: cfg.name,
      max_age: cfg.max_age,
      typeof_max_age: typeof cfg.max_age,
    });
    await jsm.streams.update(STREAM_NAME, cfg);
  } catch {
    const cfg = {
      name: STREAM_NAME,
      subjects: [SUBJECT_MESSAGES, SUBJECT_TAGS],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: maxAgeNanos,
    } as const;
    // eslint-disable-next-line no-console
    console.log("[archiver] adding stream", {
      name: cfg.name,
      max_age: cfg.max_age,
      typeof_max_age: typeof cfg.max_age,
    });
    await jsm.streams.add(cfg);
  }

  const js = params.nc.jetstream();
  const opts = consumerOpts();
  opts.durable(DURABLE_NAME);
  opts.manualAck();
  opts.ackExplicit();
  opts.deliverTo(`${DURABLE_NAME}_inbox`);
  opts.filterSubject(SUBJECT_MESSAGES);
  // We'll run two separate consumers (messages + tags) for clarity.

  const msgSub = await js.subscribe(SUBJECT_MESSAGES, opts);

  const tagOpts = consumerOpts();
  tagOpts.durable(`${DURABLE_NAME}_tags`);
  tagOpts.manualAck();
  tagOpts.ackExplicit();
  tagOpts.deliverTo(`${DURABLE_NAME}_tags_inbox`);
  tagOpts.filterSubject(SUBJECT_TAGS);
  const tagSub = await js.subscribe(SUBJECT_TAGS, tagOpts);

  async function handleMessage(data: Uint8Array) {
    const parsed = BusEventSchema.parse(JSON.parse(sc.decode(data)));
    if (parsed.type !== "MessageCreated") return;

    const msg = parsed.message;
    const { realtime: _realtime, ...msgForArchive } = msg as typeof msg & { realtime?: boolean };
    await params.db.query(
      `
      INSERT INTO bus_messages (
        id, "createdAt", "sourceModule", "sourceStream",
        message, "followMe", "followMePanel", "from",
        "isDirectMention", "isDigest", "isSystemMessage", likes,
        "tagsJson", "rawJson"
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14
      )
      ON CONFLICT (id) DO NOTHING
      `,
      [
        msg.id,
        msg.createdAt,
        msg.source.module,
        msg.source.stream ?? null,
        msg.Message ?? null,
        msg.followMePanel?.href ?? null,
        msg.followMePanel ?? null,
        msg.From ?? null,
        msg.isDirectMention,
        msg.isDigest,
        msg.isSystemMessage,
        typeof msg.likes === "number" ? msg.likes : null,
        msg.tags ?? {},
        msgForArchive,
      ],
    );
  }

  async function handleTag(data: Uint8Array) {
    const parsed = BusEventSchema.parse(JSON.parse(sc.decode(data)));
    if (parsed.type !== "TagAppended") return;

    await params.db.query(
      `
      INSERT INTO bus_tags (
        id, "createdAt", "createdByModule", "messageId", key, "valueJson"
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO NOTHING
      `,
      [
        parsed.id,
        parsed.createdAt,
        parsed.createdByModule,
        parsed.messageId,
        parsed.key,
        parsed.value,
      ],
    );
  }

  (async () => {
    for await (const m of msgSub) {
      try {
        await handleMessage(m.data);
        m.ack();
      } catch (err) {
        // Fail fast; allow retry via redelivery.
        // eslint-disable-next-line no-console
        console.error("[archiver] failed to archive message", err);
        publishLog(
          "error",
          "archiver failed to archive message",
          err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        );
      }
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[archiver] message loop crashed", err);
    publishLog(
      "error",
      "archiver message loop crashed",
      err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    );
  });

  (async () => {
    for await (const m of tagSub) {
      try {
        await handleTag(m.data);
        m.ack();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[archiver] failed to archive tag", err);
        publishLog(
          "error",
          "archiver failed to archive tag",
          err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        );
      }
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[archiver] tag loop crashed", err);
    publishLog(
      "error",
      "archiver tag loop crashed",
      err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    );
  });
}
