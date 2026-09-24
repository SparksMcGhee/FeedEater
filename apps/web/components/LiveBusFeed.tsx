"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function renderMessageText(text: string) {
  const parts: Array<JSX.Element | string> = [];
  const pattern =
    /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|((?:https?:\/\/|mailto:)[^\s<]+[^\s<.,;:!?)\]])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1] && match[2]) {
      const label = match[1];
      const href = match[2];
      parts.push(
        <a
          key={`${match.index}-${href}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--accent)" }}
        >
          {label}
        </a>,
      );
    } else if (match[3]) {
      const href = match[3];
      parts.push(
        <a
          key={`${match.index}-${href}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--accent)" }}
        >
          {href}
        </a>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}

type BusEnvelope = {
  subject: string;
  receivedAt: string;
  narrativeSummaryShort?: string | null;
  data: {
    type: "MessageCreated";
    message: {
      id: string;
      createdAt: string;
      source: { module: string; stream?: string };
      realtime?: boolean;
      Message?: string;
      followMePanel?: {
        module: string;
        panelId: string;
        href?: string;
        label?: string;
      };
      From?: string;
      isDirectMention: boolean;
      isDigest: boolean;
      isSystemMessage: boolean;
      likes?: number;
      tags: Record<string, string | number | boolean>;
    };
  };
};

type ModulesResponse = { modules: Array<{ name: string }> };
type SettingsResponse = {
  module: string;
  settings: Array<{ key: string; isSecret: boolean; value: string | null }>;
};
type BusHistoryResponse =
  | { ok: true; sinceMinutes: number; limit: number; items: BusEnvelope[] }
  | { ok: false; error: string };

export function LiveBusFeed() {
  const [items, setItems] = useState<BusEnvelope[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [modules, setModules] = useState<string[]>([]);

  const [historyMinutes, setHistoryMinutes] = useState(60);
  const [limit, setLimit] = useState(200);
  const [filterModule, setFilterModule] = useState("");
  const [filterStream, setFilterStream] = useState("");
  const [search, setSearch] = useState("");
  const [showIds, setShowIds] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const seenIdsRef = useRef<Set<string>>(new Set());

  async function saveSetting(key: string, value: string) {
    await fetch(`/api/settings/${encodeURIComponent("system")}/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value, isSecret: false }),
    }).catch(() => null);
  }

  async function loadSettingsAndModules() {
    try {
      const [modsRes, sysRes] = await Promise.all([
        fetch("/api/modules", { cache: "no-store" }),
        fetch("/api/settings/system", { cache: "no-store" }),
      ]);
      if (modsRes.ok) {
        const data = (await modsRes.json()) as ModulesResponse;
        setModules((data.modules ?? []).map((m) => m.name).sort());
      }
      if (sysRes.ok) {
        const data = (await sysRes.json()) as SettingsResponse;
        const byKey = new Map((data.settings ?? []).map((s) => [s.key, s.value ?? ""]));
        const hm = Number(byKey.get("dashboard_bus_history_minutes") ?? "60");
        const lim = Number(byKey.get("dashboard_bus_limit") ?? "200");
        const mod = String(byKey.get("dashboard_bus_filter_module") ?? "");
        const stream = String(byKey.get("dashboard_bus_filter_stream") ?? "");
        const q = String(byKey.get("dashboard_bus_search") ?? "");
        const show = String(byKey.get("dashboard_show_ids") ?? "false");
        if (Number.isFinite(hm) && hm >= 0) setHistoryMinutes(hm);
        if (Number.isFinite(lim) && lim > 0) setLimit(lim);
        setFilterModule(mod);
        setFilterStream(stream);
        setSearch(q);
        setShowIds(show === "true");
      }
    } catch {
      // ignore
    }
  }

  async function loadHistory() {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const url = new URL("/api/bus/history", window.location.origin);
      url.searchParams.set("sinceMinutes", String(historyMinutes));
      url.searchParams.set("limit", String(limit));
      if (filterModule.trim()) url.searchParams.set("module", filterModule.trim());
      if (filterStream.trim()) url.searchParams.set("stream", filterStream.trim());
      if (search.trim()) url.searchParams.set("q", search.trim());

      const res = await fetch(url.toString(), { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as BusHistoryResponse | null;
      if (!res.ok || !json) throw new Error(`History failed (${res.status})`);
      if (!json.ok) throw new Error(json.error);

      const next: BusEnvelope[] = [];
      const seen = new Set<string>();
      for (const e of json.items ?? []) {
        const id = e?.data?.message?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        next.push(e);
      }
      // Prime dedupe set so live SSE doesn't duplicate history.
      seenIdsRef.current = new Set(seen);
      setItems(next);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingHistory(false);
    }
  }

  useEffect(() => {
    void loadSettingsAndModules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSettingsAndModules]);

  useEffect(() => {
    // Reload history when filters change.
    void loadHistory();
    // Persist settings (best-effort).
    void saveSetting("dashboard_bus_history_minutes", String(historyMinutes));
    void saveSetting("dashboard_bus_limit", String(limit));
    void saveSetting("dashboard_bus_filter_module", filterModule);
    void saveSetting("dashboard_bus_filter_stream", filterStream);
    void saveSetting("dashboard_bus_search", search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMinutes, limit, filterModule, filterStream, search, loadHistory, saveSetting]);

  useEffect(() => {
    void saveSetting("dashboard_show_ids", String(showIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIds, saveSetting]);

  useEffect(() => {
    const es = new EventSource("/api/bus/stream");

    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error");

    es.addEventListener("message", (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as BusEnvelope;
        if (parsed?.data?.type !== "MessageCreated") return;
        const msg = parsed.data.message;
        const id = msg?.id;
        if (!id) return;

        // Optional client-side filtering for live messages (history query already filters server-side).
        if (filterModule && msg.source?.module !== filterModule) return;
        if (filterStream && (msg.source?.stream ?? "") !== filterStream) return;
        if (search) {
          const q = search.toLowerCase();
          const hay = `${msg.Message ?? ""}\n${msg.From ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return;
        }

        if (seenIdsRef.current.has(id)) return;
        seenIdsRef.current.add(id);
        setItems((prev: BusEnvelope[]) => [parsed, ...prev].slice(0, Math.max(200, limit)));
      } catch {
        // ignore
      }
    });

    return () => {
      setStatus("closed");
      es.close();
    };
  }, [filterModule, filterStream, search, limit]);

  const header = useMemo(() => {
    if (status === "open") return "Live Bus Feed";
    if (status === "connecting") return "Live Bus Feed (connecting…)";
    if (status === "error") return "Live Bus Feed (error)";
    return "Live Bus Feed (closed)";
  }, [status]);

  return (
    <div className="card">
      <div style={{ fontSize: 20, fontWeight: 700 }}>{header}</div>
      <div style={{ height: 10 }} />

      <div className="muted" style={{ marginBottom: 12 }}>
        Showing history from Postgres + streaming <code>feedeater.*.messageCreated</code> from NATS
        via SSE.
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          History (minutes)
          <input
            type="number"
            value={historyMinutes}
            min={0}
            max={60 * 24 * 30}
            onChange={(e: any) => setHistoryMinutes(Number(e?.target?.value))}
            style={{
              width: 110,
              padding: "8px 10px",
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "rgba(0,0,0,0.2)",
              color: "var(--text)",
              outline: "none",
            }}
          />
        </label>

        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          Limit
          <input
            type="number"
            value={limit}
            min={1}
            max={500}
            onChange={(e: any) => setLimit(Number(e?.target?.value))}
            style={{
              width: 90,
              padding: "8px 10px",
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "rgba(0,0,0,0.2)",
              color: "var(--text)",
              outline: "none",
            }}
          />
        </label>

        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          Module
          <select
            value={filterModule}
            onChange={(e: any) => setFilterModule(String(e?.target?.value ?? ""))}
            style={{
              padding: "8px 10px",
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "rgba(0,0,0,0.2)",
              color: "var(--text)",
              outline: "none",
            }}
          >
            <option value="">(all)</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          Stream
          <input
            value={filterStream}
            onChange={(e: any) => setFilterStream(String(e?.target?.value ?? ""))}
            placeholder="(any)"
            style={{
              width: 160,
              padding: "8px 10px",
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: "rgba(0,0,0,0.2)",
              color: "var(--text)",
              outline: "none",
            }}
          />
        </label>

        <input
          value={search}
          onChange={(e: any) => setSearch(String(e?.target?.value ?? ""))}
          placeholder="Search message/from…"
          style={{
            flex: "1 1 240px",
            minWidth: 220,
            padding: "8px 10px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "rgba(0,0,0,0.2)",
            color: "var(--text)",
            outline: "none",
          }}
        />
        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          <input type="checkbox" checked={showIds} onChange={(e) => setShowIds(e.target.checked)} />
          Show IDs
        </label>

        <button
          type="button"
          onClick={() => void loadHistory()}
          disabled={loadingHistory}
          style={{
            padding: "8px 10px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "rgba(255,255,255,0.04)",
            color: "var(--text)",
            cursor: "pointer",
            fontWeight: 700,
            fontSize: 12,
          }}
        >
          {loadingHistory ? "Loading…" : "Reload history"}
        </button>
      </div>

      {historyError ? (
        <div style={{ marginBottom: 12, color: "rgba(255,120,120,0.9)", fontSize: 12 }}>
          {historyError}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 10 }}>
        {items.length === 0 ? (
          <div className="muted">{loadingHistory ? "Loading…" : "No messages yet."}</div>
        ) : (
          items.map((e: BusEnvelope) => {
            const m = e.data.message;
            const summary = e.narrativeSummaryShort ?? "";
            return (
              <div
                key={`${m.id}:${e.receivedAt}`}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  padding: 12,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ fontWeight: 700 }}>
                    {m.source.module}
                    {summary ? <span className="muted"> · {summary}</span> : null}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {new Date(m.createdAt).toLocaleString()}
                  </div>
                </div>

                {showIds ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    messageId: <code>{m.id}</code>
                  </div>
                ) : null}

                {m.From ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    From: {m.From}
                  </div>
                ) : null}

                {m.Message ? (
                  <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                    {renderMessageText(m.Message)}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                  {m.isDirectMention ? <span className="muted">directMention</span> : null}
                  {m.isDigest ? <span className="muted">digest</span> : null}
                  {m.isSystemMessage ? <span className="muted">system</span> : null}
                  {typeof m.likes === "number" ? (
                    <span className="muted">likes: {m.likes}</span>
                  ) : null}
                  {m.followMePanel ? (
                    m.followMePanel.href ? (
                      <a
                        href={m.followMePanel.href}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "var(--accent)" }}
                      >
                        {m.followMePanel.label ?? "Follow"}
                      </a>
                    ) : (
                      <span className="muted">
                        Follow: {m.followMePanel.module}.{m.followMePanel.panelId}
                      </span>
                    )
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
