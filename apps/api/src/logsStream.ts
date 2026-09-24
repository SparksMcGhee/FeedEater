import type { Request, Response } from "express";
import type { NatsConnection, StringCodec } from "nats";

export function getLogsStream(params: {
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
    const sub = nc.subscribe("feedeater.*.log");

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
          const payload = { subject: m.subject, receivedAt: new Date().toISOString(), data };
          res.write("event: log\n");
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
