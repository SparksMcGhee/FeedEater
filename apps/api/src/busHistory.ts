import { busMessage, db } from "@feedeater/db";
import { and, desc, eq, gte, ilike, or, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// Prisma's `contains` escapes LIKE metacharacters; replicate that.
function likeParam(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function getBusHistory(req: Request, res: Response) {
  try {
    const sinceMinutesRaw = req.query.sinceMinutes;
    const limitRaw = req.query.limit;
    const moduleRaw = req.query.module;
    const streamRaw = req.query.stream;
    const qRaw = req.query.q;

    const sinceMinutes = clamp(Number(sinceMinutesRaw ?? 60), 0, 60 * 24 * 30); // up to 30d
    const limit = clamp(Number(limitRaw ?? 200), 1, 500);

    const moduleFilter = typeof moduleRaw === "string" ? moduleRaw.trim() : "";
    const streamFilter = typeof streamRaw === "string" ? streamRaw.trim() : "";
    const q = typeof qRaw === "string" ? qRaw.trim() : "";

    const since = new Date(Date.now() - sinceMinutes * 60_000);

    const conditions: SQL[] = [];
    if (sinceMinutes > 0) conditions.push(gte(busMessage.createdAt, since));
    if (moduleFilter) conditions.push(eq(busMessage.sourceModule, moduleFilter));
    if (streamFilter) conditions.push(eq(busMessage.sourceStream, streamFilter));
    if (q)
      conditions.push(
        or(ilike(busMessage.message, likeParam(q)), ilike(busMessage.from, likeParam(q)))!,
      );

    const rows = await db.query.busMessage.findMany({
      where: and(...conditions),
      orderBy: (m, { desc: d }) => [d(m.createdAt)],
      limit,
      with: {
        narratives: {
          with: { narrative: { columns: { summaryShort: true } } },
        },
      },
    });

    res.json({
      ok: true,
      sinceMinutes,
      limit,
      items: rows.map((r) => ({
        subject: `feedeater.${r.sourceModule}.messageCreated`,
        receivedAt: r.createdAt.toISOString(),
        narrativeSummaryShort: r.narratives[0]?.narrative?.summaryShort ?? null,
        data: { type: "MessageCreated", message: r.rawJson },
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
