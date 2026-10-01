import { NarrativeUpdatedEventSchema } from "@feedeater/core";
import { busMessage, busNarrative, busNarrativeMessage, db } from "@feedeater/db";
import { and, asc, count, desc, eq, gte, ilike, inArray, or, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import type { NatsConnection, StringCodec } from "nats";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function likeParam(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function normalizeKeyPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

export function getNarrativesHistory(req: Request, res: Response) {
  return (async () => {
    try {
      const sinceMinutesRaw = req.query.sinceMinutes;
      const limitRaw = req.query.limit;
      const moduleRaw = req.query.module;
      const qRaw = req.query.q;

      const sinceMinutes = clamp(Number(sinceMinutesRaw ?? 60), 0, 60 * 24 * 30);
      const limit = clamp(Number(limitRaw ?? 200), 1, 500);
      const moduleFilter = typeof moduleRaw === "string" ? moduleRaw.trim() : "";
      const q = typeof qRaw === "string" ? qRaw.trim() : "";

      const since = new Date(Date.now() - sinceMinutes * 60_000);
      const conditions: SQL[] = [];
      if (sinceMinutes > 0) conditions.push(gte(busNarrative.updatedAt, since));
      if (moduleFilter) conditions.push(eq(busNarrative.ownerModule, moduleFilter));
      if (q)
        conditions.push(
          or(
            ilike(busNarrative.summaryShort, likeParam(q)),
            ilike(busNarrative.summaryLong, likeParam(q)),
          )!,
        );

      const rows = await db
        .select()
        .from(busNarrative)
        .where(and(...conditions))
        .orderBy(desc(busNarrative.updatedAt))
        .limit(limit);

      const countRows = rows.length
        ? await db
            .select({ narrativeId: busNarrativeMessage.narrativeId, c: count() })
            .from(busNarrativeMessage)
            .where(
              inArray(
                busNarrativeMessage.narrativeId,
                rows.map((r) => r.id),
              ),
            )
            .groupBy(busNarrativeMessage.narrativeId)
        : [];
      const counts = new Map(countRows.map((x) => [x.narrativeId, Number(x.c)]));

      res.json({
        ok: true,
        sinceMinutes,
        limit,
        items: rows.map((r) => ({
          id: r.id,
          ownerModule: r.ownerModule,
          sourceKey: r.sourceKey,
          summaryShort: r.summaryShort,
          summaryLong: r.summaryLong,
          keyPoints: normalizeKeyPoints(r.keyPoints),
          version: r.version,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          messageCount: counts.get(r.id) ?? 0,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
}

export function getNarrativeMessages(req: Request, res: Response) {
  return (async () => {
    try {
      const narrativeIdRaw = req.query.narrativeId;
      const ownerModuleRaw = req.query.ownerModule;
      const sourceKeyRaw = req.query.sourceKey;

      const narrativeId = typeof narrativeIdRaw === "string" ? narrativeIdRaw.trim() : "";
      const ownerModule = typeof ownerModuleRaw === "string" ? ownerModuleRaw.trim() : "";
      const sourceKey = typeof sourceKeyRaw === "string" ? sourceKeyRaw.trim() : "";

      let narrative = null as null | {
        id: string;
        ownerModule: string;
        sourceKey: string;
        summaryShort: string;
        summaryLong: string;
        keyPoints: unknown;
        version: number;
        createdAt: Date;
        updatedAt: Date;
      };

      if (narrativeId) {
        narrative =
          (await db.select().from(busNarrative).where(eq(busNarrative.id, narrativeId)))[0] ?? null;
      } else if (ownerModule && sourceKey) {
        narrative =
          (
            await db
              .select()
              .from(busNarrative)
              .where(
                and(
                  eq(busNarrative.ownerModule, ownerModule),
                  eq(busNarrative.sourceKey, sourceKey),
                ),
              )
          )[0] ?? null;
      }

      if (!narrative) {
        res.status(404).json({ ok: false, error: "Narrative not found" });
        return;
      }

      const rows = await db
        .select({
          id: busMessage.id,
          createdAt: busMessage.createdAt,
          raw: busMessage.rawJson,
        })
        .from(busNarrativeMessage)
        .innerJoin(busMessage, eq(busNarrativeMessage.messageId, busMessage.id))
        .where(eq(busNarrativeMessage.narrativeId, narrative.id))
        .orderBy(asc(busNarrativeMessage.createdAt));

      res.json({
        ok: true,
        narrative: {
          id: narrative.id,
          ownerModule: narrative.ownerModule,
          sourceKey: narrative.sourceKey,
          summaryShort: narrative.summaryShort,
          summaryLong: narrative.summaryLong,
          keyPoints: normalizeKeyPoints(narrative.keyPoints),
          version: narrative.version,
          createdAt: narrative.createdAt.toISOString(),
          updatedAt: narrative.updatedAt.toISOString(),
        },
        messages: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          raw: r.raw,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
}

export function getNarrativesStream(params: {
  getNatsConn: () => Promise<NatsConnection>;
  sc: StringCodec;
}) {
  return async (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const keepalive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 15000);

    const nc = await params.getNatsConn();
    const sub = nc.subscribe("feedeater.*.narrativeUpdated");

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
            data = JSON.parse(params.sc.decode(m.data));
          } catch {
            data = { parseError: true };
          }

          const parsed = NarrativeUpdatedEventSchema.safeParse(data);
          if (!parsed.success) continue;
          const nv = parsed.data.narrative;
          if (!nv.ownerModule || !nv.sourceKey) continue;

          const record =
            (
              await db
                .select()
                .from(busNarrative)
                .where(
                  and(
                    eq(busNarrative.ownerModule, nv.ownerModule),
                    eq(busNarrative.sourceKey, nv.sourceKey),
                  ),
                )
            )[0] ?? null;
          if (!record) continue;

          const [cnt] = await db
            .select({ c: count() })
            .from(busNarrativeMessage)
            .where(eq(busNarrativeMessage.narrativeId, record.id));

          const payload = {
            subject: m.subject,
            receivedAt: new Date().toISOString(),
            messageId: parsed.data.messageId ?? null,
            narrative: {
              id: record.id,
              ownerModule: record.ownerModule,
              sourceKey: record.sourceKey,
              summaryShort: record.summaryShort,
              summaryLong: record.summaryLong,
              keyPoints: normalizeKeyPoints(record.keyPoints),
              version: record.version,
              createdAt: record.createdAt.toISOString(),
              updatedAt: record.updatedAt.toISOString(),
              messageCount: Number(cnt?.c ?? 0),
            },
          };

          res.write("event: narrative\n");
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch {
        // ignore
      } finally {
        clearInterval(keepalive);
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    })();
  };
}
