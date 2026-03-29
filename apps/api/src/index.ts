import express from "express";
import type { NextFunction, Request, Response } from "express";
import { connect, StringCodec } from "nats";
import { prisma } from "@feedeater/db";
import { getModuleSettings, getModuleSettingsInternal, putModuleSetting } from "./settings.js";
import { getAiTags, postAiEmbedding, postAiSummary } from "./ai.js";
import { getNarrativeMessages, getNarrativesHistory, getNarrativesStream } from "./narratives.js";
import { discoverModules } from "./modules.js";
import { getSlackChannels } from "./slackChannels.js";
import { getLogsStream } from "./logsStream.js";
import { getJobsStatus, postRunJob } from "./jobs.js";
import { getBusHistory } from "./busHistory.js";

const PORT = Number(process.env.PORT ?? "4000");
const MODULES_DIR = process.env.FEED_MODULES_DIR ?? "/app/modules";
const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

requiredEnv("NATS_URL");
requiredEnv("DATABASE_URL");
requiredEnv("FEED_SETTINGS_KEY");
requiredEnv("FEED_INTERNAL_TOKEN");
const natsSc = StringCodec();
let natsConnPromise: Promise<import("nats").NatsConnection> | null = null;

function getNatsConn() {
  if (!natsConnPromise) natsConnPromise = connect({ servers: NATS_URL });
  return natsConnPromise;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Permit embedding internal UI panels (same-origin iframe).
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  next();
});

app.get("/api/health", async (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/api/modules", async (_req: Request, res: Response) => {
  const modules = await discoverModules(MODULES_DIR);
  res.json({ modules });
});

// Server-Sent Events: live stream of MessageCreated bus events.
app.get("/api/bus/stream", async (req: Request, res: Response) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const keepalive = setInterval(() => {
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, 15000);

  const nc = await getNatsConn();
  const sub = nc.subscribe("feedeater.*.messageCreated");

  let closed = false;
  req.on("close", () => {
    closed = true;
    clearInterval(keepalive);
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
  });

  (async () => {
    try {
      for await (const m of sub) {
        if (closed) break;

        let data: unknown = null;
        try {
          data = JSON.parse(natsSc.decode(m.data));
        } catch {
          data = { parseError: true };
        }

        let narrativeSummaryShort: string | null = null;
        try {
          const msg = (data as any)?.message;
          const ref = msg?.narrativeRef ?? msg?.contextRef;
          if (ref?.ownerModule && ref?.sourceKey) {
            const nv = await prisma.busNarrative.findUnique({
              where: { ownerModule_sourceKey: { ownerModule: String(ref.ownerModule), sourceKey: String(ref.sourceKey) } },
              select: { summaryShort: true },
            });
            narrativeSummaryShort = nv?.summaryShort ?? null;
          }
        } catch {
          // ignore
        }

        const payload = {
          subject: m.subject,
          receivedAt: new Date().toISOString(),
          narrativeSummaryShort,
          data,
        };

        res.write("event: message\n");
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } catch {
      // likely client disconnected
    } finally {
      clearInterval(keepalive);
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  })();
});

// Historical bus messages (from Postgres archive).
app.get("/api/bus/history", getBusHistory);
app.get("/api/narratives/history", getNarrativesHistory);
app.get("/api/narratives/messages", getNarrativeMessages);
app.get("/api/narratives/stream", getNarrativesStream({ getNatsConn, sc: natsSc }));

app.get("/api/settings/:module", getModuleSettings);
app.put("/api/settings/:module/:key", putModuleSetting);
app.get("/api/internal/settings/:module", getModuleSettingsInternal);
app.post("/api/internal/ai/summary", postAiSummary());
app.post("/api/internal/ai/embedding", postAiEmbedding());
app.get("/api/internal/ai/tags", getAiTags());
app.get("/api/modules/slack/channels", getSlackChannels);
app.get("/api/logs/stream", getLogsStream({ getNatsConn, sc: natsSc }));
app.get("/api/jobs/status", getJobsStatus({ modulesDir: MODULES_DIR }));
app.post("/api/jobs/run", postRunJob({ modulesDir: MODULES_DIR, getNatsConn, sc: natsSc }));

app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${PORT}`);
});


