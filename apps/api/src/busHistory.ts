import { prisma } from "@feedeater/db";
import type { Request, Response } from "express";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
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

    const rows = await prisma.busMessage.findMany({
      where: {
        ...(sinceMinutes > 0 ? { createdAt: { gte: since } } : {}),
        ...(moduleFilter ? { sourceModule: moduleFilter } : {}),
        ...(streamFilter ? { sourceStream: streamFilter } : {}),
        ...(q
          ? {
              OR: [
                { message: { contains: q, mode: "insensitive" } },
                { from: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        narratives: {
          include: { narrative: true },
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
        narrativeSummaryShort: r.narratives?.[0]?.narrative?.summaryShort ?? null,
        data: { type: "MessageCreated", message: r.rawJson },
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
