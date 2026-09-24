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

type NarrativeItem = {
  id: string;
  ownerModule: string;
  sourceKey: string;
  summaryShort: string;
  summaryLong: string;
  keyPoints: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

type NarrativeStreamEnvelope = {
  subject: string;
  receivedAt: string;
  messageId: string | null;
  narrative: NarrativeItem;
};

type NarrativeHistoryResponse =
  | { ok: true; sinceMinutes: number; limit: number; items: NarrativeItem[] }
  | { ok: false; error: string };

type NarrativeMessagesResponse =
  | {
      ok: true;
      narrative: NarrativeItem;
      messages: Array<{ id: string; createdAt: string; raw: unknown }>;
    }
  | { ok: false; error: string };

type SettingsResponse = {
  module: string;
  settings: Array<{ key: string; isSecret: boolean; value: string | null }>;
};
type ModulesResponse = { modules: Array<{ name: string }> };

export function LiveNarrativesFeed() {
  const [items, setItems] = useState<NarrativeItem[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [modules, setModules] = useState<string[]>([]);

  const [historyMinutes, setHistoryMinutes] = useState(60);
  const [limit, setLimit] = useState(200);
  const [filterModule, setFilterModule] = useState("");
  const [search, setSearch] = useState("");
  const [showIds, setShowIds] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [messagesById, setMessagesById] = useState<
    Record<string, Array<{ id: string; createdAt: string; raw: any }>>
  >({});
  const [messagesLoading, setMessagesLoading] = useState<Record<string, boolean>>({});
  const [messagesError, setMessagesError] = useState<Record<string, string>>({});

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
        const hm = Number(byKey.get("dashboard_narratives_history_minutes") ?? "60");
        const lim = Number(byKey.get("dashboard_narratives_limit") ?? "200");
        const mod = String(byKey.get("dashboard_narratives_filter_module") ?? "");
        const q = String(byKey.get("dashboard_narratives_search") ?? "");
        const show = String(byKey.get("dashboard_show_ids") ?? "false");
        if (Number.isFinite(hm) && hm >= 0) setHistoryMinutes(hm);
        if (Number.isFinite(lim) && lim > 0) setLimit(lim);
        setFilterModule(mod);
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
      const url = new URL("/api/narratives/history", window.location.origin);
      url.searchParams.set("sinceMinutes", String(historyMinutes));
      url.searchParams.set("limit", String(limit));
      if (filterModule.trim()) url.searchParams.set("module", filterModule.trim());
      if (search.trim()) url.searchParams.set("q", search.trim());

      const res = await fetch(url.toString(), { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as NarrativeHistoryResponse | null;
      if (!res.ok || !json) throw new Error(`History failed (${res.status})`);
      if (!json.ok) throw new Error(json.error);

      const next: NarrativeItem[] = [];
      const seen = new Set<string>();
      for (const c of json.items ?? []) {
        if (!c?.id || seen.has(c.id)) continue;
        seen.add(c.id);
        next.push(c);
      }
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
    void loadHistory();
    void saveSetting("dashboard_narratives_history_minutes", String(historyMinutes));
    void saveSetting("dashboard_narratives_limit", String(limit));
    void saveSetting("dashboard_narratives_filter_module", filterModule);
    void saveSetting("dashboard_narratives_search", search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMinutes, limit, filterModule, search, loadHistory, saveSetting]);

  useEffect(() => {
    void saveSetting("dashboard_show_ids", String(showIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIds, saveSetting]);

  useEffect(() => {
    const es = new EventSource("/api/narratives/stream");
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error");

    es.addEventListener("narrative", (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as NarrativeStreamEnvelope;
        const nv = parsed?.narrative;
        if (!nv?.id) return;

        if (filterModule && nv.ownerModule !== filterModule) return;
        if (search) {
          const q = search.toLowerCase();
          const hay = `${nv.summaryShort}\n${nv.summaryLong}`.toLowerCase();
          if (!hay.includes(q)) return;
        }

        setItems((prev) => {
          const next = prev.filter((p) => p.id !== nv.id);
          next.unshift(nv);
          return next.slice(0, Math.max(200, limit));
        });
        seenIdsRef.current.add(nv.id);
      } catch {
        // ignore
      }
    });

    return () => {
      setStatus("closed");
      es.close();
    };
  }, [filterModule, search, limit]);

  async function toggleMessages(narrative: NarrativeItem) {
    const id = narrative.id;
    setExpanded((p) => ({ ...p, [id]: !p[id] }));
    if (messagesById[id] || messagesLoading[id]) return;

    setMessagesLoading((p) => ({ ...p, [id]: true }));
    setMessagesError((p) => ({ ...p, [id]: "" }));
    try {
      const url = new URL("/api/narratives/messages", window.location.origin);
      url.searchParams.set("narrativeId", id);
      const res = await fetch(url.toString(), { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as NarrativeMessagesResponse | null;
      if (!res.ok || !json) throw new Error(`Messages failed (${res.status})`);
      if (!json.ok) throw new Error(json.error);
      setMessagesById((p) => ({ ...p, [id]: json.messages }));
    } catch (e) {
      setMessagesError((p) => ({ ...p, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setMessagesLoading((p) => ({ ...p, [id]: false }));
    }
  }

  const header = useMemo(() => {
    if (status === "open") return "Live Narratives";
    if (status === "connecting") return "Live Narratives (connecting…)";
    if (status === "error") return "Live Narratives (error)";
    return "Live Narratives (closed)";
  }, [status]);

  return (
    <div className="card">
      <div style={{ fontSize: 20, fontWeight: 700 }}>{header}</div>
      <div style={{ height: 10 }} />
      <div className="muted" style={{ marginBottom: 12 }}>
        Showing history from Postgres + streaming <code>feedeater.*.narrativeUpdated</code> from
        NATS via SSE.
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
            onChange={(e) => setHistoryMinutes(Number(e.target.value))}
            style={{ width: 90 }}
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
            onChange={(e) => setLimit(Number(e.target.value))}
            style={{ width: 80 }}
          />
        </label>
        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          Module
          <select
            value={filterModule}
            onChange={(e) => setFilterModule(e.target.value)}
            style={{ minWidth: 150 }}
          >
            <option value="">All</option>
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
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: 240 }}
          />
        </label>
        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          <input type="checkbox" checked={showIds} onChange={(e) => setShowIds(e.target.checked)} />
          Show IDs
        </label>
      </div>

      {loadingHistory ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading history…
        </div>
      ) : historyError ? (
        <div style={{ fontSize: 12, color: "rgba(255,120,120,0.9)" }}>{historyError}</div>
      ) : null}

      <div style={{ display: "grid", gap: 10 }}>
        {items.map((nv) => {
          const id = nv.id;
          const open = Boolean(expanded[id]);
          const msgLoading = Boolean(messagesLoading[id]);
          const msgError = messagesError[id] ?? "";
          const msgs = messagesById[id] ?? [];

          return (
            <div
              key={id}
              style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "baseline",
                }}
              >
                <div style={{ fontWeight: 700 }}>{nv.summaryShort || "(no summary)"}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {nv.ownerModule} · {new Date(nv.updatedAt).toLocaleString()} · messages:{" "}
                  {nv.messageCount}
                </div>
              </div>

              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                sourceKey: <code>{nv.sourceKey}</code> · version: {nv.version}
                {showIds ? (
                  <>
                    {" "}
                    · narrativeId: <code>{nv.id}</code>
                  </>
                ) : null}
              </div>

              <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{nv.summaryLong}</div>

              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => void toggleMessages(nv)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "rgba(124,58,237,0.22)",
                    color: "var(--text)",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  {open ? "Hide messages" : "Show messages"}
                </button>
              </div>

              {open ? (
                <div style={{ marginTop: 10 }}>
                  {msgLoading ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      Loading messages…
                    </div>
                  ) : msgError ? (
                    <div style={{ fontSize: 12, color: "rgba(255,120,120,0.9)" }}>{msgError}</div>
                  ) : msgs.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      No messages linked to this narrative.
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {msgs.map((m) => {
                        const raw = (m.raw ?? {}) as {
                          Message?: string;
                          From?: string;
                          source?: { module?: string; stream?: string };
                        };
                        return (
                          <div
                            key={m.id}
                            style={{
                              border: "1px solid var(--border)",
                              borderRadius: 10,
                              padding: 8,
                            }}
                          >
                            <div className="muted" style={{ fontSize: 12 }}>
                              {raw.source?.module ?? "unknown"} ·{" "}
                              {new Date(m.createdAt).toLocaleString()}
                              {showIds ? (
                                <>
                                  {" "}
                                  · messageId: <code>{m.id}</code>
                                </>
                              ) : null}
                            </div>
                            <div style={{ marginTop: 4 }}>
                              <strong>{raw.From ?? "unknown"}</strong>:{" "}
                              {raw.Message
                                ? renderMessageText(String(raw.Message))
                                : "(no message text)"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
