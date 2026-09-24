"use client";

import { useEffect, useMemo, useState } from "react";

type LogEnvelope = {
  subject: string;
  receivedAt: string;
  data: {
    level?: "debug" | "info" | "warn" | "error";
    module?: string;
    source?: string;
    at?: string;
    message?: string;
    meta?: unknown;
  };
};

export function LiveLogsFeed() {
  const [items, setItems] = useState<LogEnvelope[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");

  useEffect(() => {
    const es = new EventSource("/api/logs/stream");
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error");

    es.addEventListener("log", (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as LogEnvelope;
        setItems((prev: LogEnvelope[]) => [parsed, ...prev].slice(0, 300));
      } catch {
        // ignore
      }
    });

    return () => {
      setStatus("closed");
      es.close();
    };
  }, []);

  const header = useMemo(() => {
    if (status === "open") return "Live Logs";
    if (status === "connecting") return "Live Logs (connecting…)";
    if (status === "error") return "Live Logs (error)";
    return "Live Logs (closed)";
  }, [status]);

  return (
    <div className="card">
      <div style={{ fontSize: 20, fontWeight: 700 }}>{header}</div>
      <div style={{ height: 10 }} />
      <div className="muted" style={{ marginBottom: 12 }}>
        Streaming <code>feedeater.*.log</code> from NATS via SSE.
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {items.length === 0 ? (
          <div className="muted">No logs yet.</div>
        ) : (
          items.map((e: LogEnvelope) => {
            const d = e.data ?? {};
            const level = d.level ?? "info";
            const color =
              level === "error"
                ? "rgba(255,120,120,0.95)"
                : level === "warn"
                  ? "rgba(255,200,120,0.95)"
                  : "var(--text)";

            return (
              <div
                key={`${e.receivedAt}:${e.subject}:${String(d.at ?? "")}:${String(d.message ?? "")}`}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  padding: 12,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ fontWeight: 700, color }}>
                    {d.module ?? e.subject} <span className="muted">· {level}</span>
                    {d.source ? <span className="muted"> · {d.source}</span> : null}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {new Date(d.at ?? e.receivedAt).toLocaleString()}
                  </div>
                </div>

                {d.message ? (
                  <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{d.message}</div>
                ) : null}

                {d.meta !== undefined ? (
                  <details style={{ marginTop: 8 }}>
                    <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
                      details
                    </summary>
                    <pre
                      style={{
                        margin: "8px 0 0 0",
                        padding: 12,
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        background: "rgba(0,0,0,0.25)",
                        overflow: "auto",
                        fontSize: 12,
                        color: "var(--text)",
                      }}
                    >
                      {JSON.stringify(d.meta, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
