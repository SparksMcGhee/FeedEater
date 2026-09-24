"use client";

import { useEffect, useMemo, useState } from "react";

type ModuleManifest = {
  name: string;
  version: string;
  namespace: string;
};

type ModuleJob = {
  name: string;
  queue: string;
  schedule?: string;
  triggeredBy?: string;
  description?: string;
};

type ModuleManifestWithJobs = ModuleManifest & { jobs?: ModuleJob[] };

type RunJobResponse =
  | { ok: true; jobId: string | number; queue: string; job: string; module: string }
  | { ok: false; error: string };
type JobStatus = {
  module: string;
  job: string;
  queue: string;
  schedule: string | null;
  triggeredBy: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastMetrics?: Record<string, unknown> | null;
  lastStatus?: string | null;
  lastRunCreatedAt?: string | null;
};
type JobStatusResponse = { ok: true; jobs: JobStatus[] } | { ok: false; error: string };

function formatDurationMs(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatMetricValue(key: string, value: unknown): string {
  if (key === "durationMs") {
    const asNumber = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(asNumber)) return formatDurationMs(asNumber);
  }
  return String(value);
}

export function JobsRunPanel() {
  const [modules, setModules] = useState<ModuleManifestWithJobs[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<Record<string, string>>({});
  const [statusByKey, setStatusByKey] = useState<Record<string, JobStatus>>({});

  async function loadStatus() {
    try {
      const res = await fetch("/api/jobs/status", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as JobStatusResponse | null;
      if (!res.ok || !json) throw new Error(`Status failed (${res.status})`);
      if (!json.ok) throw new Error(json.error);
      const next: Record<string, JobStatus> = {};
      for (const j of json.jobs ?? []) next[`${j.module}.${j.job}`] = j;
      setStatusByKey(next);
    } catch (e) {
      setResult((p) => ({ ...p, __status: e instanceof Error ? e.message : String(e) }));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/modules", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load modules (${res.status})`);
        const data = (await res.json()) as { modules: ModuleManifestWithJobs[] };
        if (cancelled) return;
        setModules(data.modules ?? []);
      } catch (e) {
        if (cancelled) return;
        setResult((p) => ({ ...p, __load: e instanceof Error ? e.message : String(e) }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  const grouped = useMemo(() => {
    const byModule = new Map<string, ModuleJob[]>();
    for (const m of modules ?? []) {
      if (!byModule.has(m.name)) byModule.set(m.name, []);
      for (const j of m.jobs ?? []) byModule.get(m.name)!.push(j);
    }
    const list = [...byModule.entries()].map(([module, jobs]) => ({
      module,
      jobs: [...jobs].sort((a, b) => a.name.localeCompare(b.name)),
    }));
    list.sort((a, b) => a.module.localeCompare(b.module));
    return list;
  }, [modules]);

  async function runNow(moduleName: string, jobName: string) {
    const key = `${moduleName}.${jobName}`;
    setRunning((p) => ({ ...p, [key]: true }));
    setResult((p) => ({ ...p, [key]: "" }));
    try {
      const res = await fetch("/api/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ module: moduleName, job: jobName }),
      });
      const json = (await res.json().catch(() => null)) as RunJobResponse | null;
      if (!res.ok || !json) {
        const body = await res.text().catch(() => "");
        throw new Error(`Run failed (${res.status}) ${body}`);
      }
      if (!json.ok) throw new Error(json.error);
      setResult((p) => ({ ...p, [key]: `Enqueued (jobId=${String(json.jobId)})` }));
      void loadStatus();
    } catch (e) {
      setResult((p) => ({ ...p, [key]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRunning((p) => ({ ...p, [key]: false }));
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 12,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "baseline",
        }}
      >
        <div style={{ fontWeight: 700 }}>Run now</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Manual triggers are enabled for all jobs
        </div>
      </div>

      {result.__load ? (
        <div style={{ marginTop: 8, color: "rgba(255,120,120,0.9)", fontSize: 12 }}>
          {result.__load}
        </div>
      ) : null}
      {result.__status ? (
        <div style={{ marginTop: 6, color: "rgba(255,160,120,0.9)", fontSize: 12 }}>
          {result.__status}
        </div>
      ) : null}

      <div style={{ height: 10 }} />

      {loading || !modules ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : grouped.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No jobs found.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {grouped.map(({ module: moduleName, jobs }) => (
            <div key={moduleName}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                {moduleName}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {jobs.map((job) => {
                  const key = `${moduleName}.${job.name}`;
                  const busy = Boolean(running[key]);
                  const msg = result[key] ?? "";
                  const status = statusByKey[key]?.lastStatus ?? "";
                  const statusColor =
                    status === "running"
                      ? "rgba(80,160,255,0.9)"
                      : status === "error"
                        ? "rgba(255,120,120,0.9)"
                        : statusByKey[key]?.lastSuccessAt
                          ? "rgba(120,255,180,0.9)"
                          : "rgba(160,160,160,0.7)";
                  return (
                    <div
                      key={key}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 14,
                        padding: 12,
                        background: "rgba(0,0,0,0.18)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          alignItems: "baseline",
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>
                          <span
                            style={{
                              display: "inline-block",
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              marginRight: 8,
                              background: statusColor,
                            }}
                          />
                          {moduleName}.{job.name}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          queue: <code>{job.queue}</code> ·{" "}
                          {job.schedule ? (
                            <>
                              schedule: <code>{job.schedule}</code>
                            </>
                          ) : (
                            "manual"
                          )}
                        </div>
                      </div>

                      {job.description ? (
                        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                          {job.description}
                        </div>
                      ) : null}

                      {statusByKey[key]?.lastError ? (
                        <div
                          style={{
                            marginTop: 8,
                            fontSize: 12,
                            color: "rgba(255,120,120,0.9)",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          Last error: {statusByKey[key]?.lastError}
                        </div>
                      ) : null}
                      {statusByKey[key]?.lastRunAt ? (
                        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                          Last run: {statusByKey[key]?.lastRunAt}
                        </div>
                      ) : null}
                      {statusByKey[key]?.lastMetrics ? (
                        <div style={{ marginTop: 8 }}>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                            Metrics
                          </div>
                          <div
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: 10,
                              overflow: "hidden",
                              fontSize: 12,
                            }}
                          >
                            {Object.entries(statusByKey[key]?.lastMetrics ?? {}).map(([k, v]) => (
                              <div
                                key={k}
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "160px 1fr",
                                  gap: 8,
                                  padding: "6px 10px",
                                  borderTop: "1px solid var(--border)",
                                }}
                              >
                                <div className="muted">{k}</div>
                                <div style={{ wordBreak: "break-word" }}>
                                  {formatMetricValue(k, v)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                          marginTop: 10,
                          flexWrap: "wrap",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => void runNow(moduleName, job.name)}
                          disabled={busy}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: "1px solid var(--border)",
                            background: "rgba(124,58,237,0.22)",
                            color: "var(--text)",
                            cursor: "pointer",
                            fontWeight: 700,
                          }}
                        >
                          {busy ? "Enqueuing…" : "Run now"}
                        </button>

                        {msg ? (
                          <div
                            className="muted"
                            style={{
                              fontSize: 12,
                              color: msg.startsWith("Enqueued")
                                ? "rgba(170,255,200,0.9)"
                                : "rgba(255,120,120,0.9)",
                            }}
                          >
                            {msg}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
