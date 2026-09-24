"use client";

import { useEffect, useMemo, useState } from "react";

type SlackChannelsApiResponse =
  | {
      ok: true;
      pages: number;
      channels: Array<{
        id: string;
        name: string;
        isPrivate: boolean;
        isMember: boolean;
        isArchived: boolean;
        numMembers?: number;
        topic?: string;
        purpose?: string;
      }>;
    }
  | { ok: false; error: string };

type SlackChannel = Extract<SlackChannelsApiResponse, { ok: true }>["channels"][number];

type SlackSettingsGetResponse = {
  module: string;
  settings: Array<{ key: string; isSecret: boolean; value: string | null }>;
};

export function SlackChannelsCard() {
  const [data, setData] = useState<SlackChannelsApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyMember, setOnlyMember] = useState(true);
  const [includePrivate, setIncludePrivate] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function loadChannels() {
    setLoading(true);
    try {
      const url = new URL("/api/modules/slack/channels", window.location.origin);
      url.searchParams.set(
        "types",
        includePrivate ? "public_channel,private_channel" : "public_channel",
      );
      url.searchParams.set("includeArchived", includeArchived ? "true" : "false");
      const res = await fetch(url.toString(), { cache: "no-store" });
      const json = (await res.json()) as SlackChannelsApiResponse;
      setData(json);
      if (json.ok) {
        void saveChannelNameMap(json.channels);
      }
    } catch (e) {
      setData({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }

  async function saveChannelNameMap(channels: SlackChannel[]) {
    try {
      const map = Object.fromEntries(channels.map((c) => [c.id, c.name]));
      const res = await fetch(
        `/api/settings/${encodeURIComponent("slack")}/${encodeURIComponent("channelNameMap")}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: JSON.stringify(map), isSecret: false }),
        },
      );
      if (!res.ok) throw new Error(`Save channel map failed (${res.status})`);
    } catch {
      // ignore: best-effort cache for background jobs
    }
  }

  async function loadSelectedFromSettings() {
    try {
      const res = await fetch("/api/settings/slack", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as SlackSettingsGetResponse;
      const row = (json.settings ?? []).find((s) => s.key === "channelIds");
      const raw = row?.value ?? "";
      const parts = raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      setSelectedIds(new Set(parts));
    } catch {
      // ignore
    }
  }

  async function saveSelected(next: Set<string>) {
    setSaving(true);
    setSaveError(null);
    try {
      const value = [...next].join(",");
      const res = await fetch(
        `/api/settings/${encodeURIComponent("slack")}/${encodeURIComponent("channelIds")}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value, isSecret: false }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Save failed (${res.status}) ${body}`);
      }
      setSelectedIds(new Set(next));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    void loadChannels();
    void loadSelectedFromSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSelectedFromSettings, loadChannels]);

  const items = useMemo<SlackChannel[]>(() => {
    if (!data?.ok) return [];
    const q = query.trim().toLowerCase();
    return data.channels.filter((c: SlackChannel) => {
      if (onlyMember && !c.isMember) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
    });
  }, [data, query, onlyMember]);

  const selectedCount = selectedIds.size;

  async function toggleChannel(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    await saveSelected(next);
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        Lists channels the saved <code>botToken</code> can see. Required Slack scopes:{" "}
        <code>channels:read</code> (public channels) and <code>groups:read</code> (private
        channels). After changing scopes, reinstall the Slack app to refresh the token.
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void loadChannels()}
          disabled={loading}
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
          {loading ? "Loading…" : "Refresh"}
        </button>

        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={!data || (data.ok && data.channels.length === 0)}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "rgba(255,255,255,0.04)",
            color: "var(--text)",
            cursor: "pointer",
            fontWeight: 700,
          }}
          title="Browse all channels in a scrollable modal"
        >
          Browse channels
        </button>

        <div className="muted" style={{ fontSize: 12 }}>
          Selected: <b>{selectedCount}</b>
        </div>

        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          <input
            type="checkbox"
            checked={onlyMember}
            onChange={(e) => setOnlyMember(e.target.checked)}
          />
          Only show channels the bot is in
        </label>

        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          <input
            type="checkbox"
            checked={includePrivate}
            onChange={(e) => setIncludePrivate(e.target.checked)}
          />
          Include private channels
        </label>

        <label
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
        >
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Include archived
        </label>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or ID…"
          style={{
            flex: "1 1 320px",
            minWidth: 240,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "rgba(0,0,0,0.2)",
            color: "var(--text)",
            outline: "none",
          }}
        />
      </div>

      {data && !data.ok ? (
        <div style={{ color: "rgba(255,120,120,0.9)", fontSize: 12 }}>
          {data.error}
          {data.error.includes("missing_scope") ? (
            <div className="muted" style={{ marginTop: 6 }}>
              Tip: if you only want public channels, uncheck “Include private channels”. Otherwise
              add <code>channels:read</code> and <code>groups:read</code> to your Slack app,
              reinstall it, then update the saved <code>botToken</code>.
            </div>
          ) : null}
        </div>
      ) : null}

      {saveError ? (
        <div style={{ color: "rgba(255,120,120,0.9)", fontSize: 12 }}>{saveError}</div>
      ) : null}

      {data?.ok ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Found <b>{data.channels.length}</b> channels (paged in <b>{data.pages}</b> request
          {data.pages === 1 ? "" : "s"}). Showing <b>{items.length}</b>.
        </div>
      ) : null}

      <div className="muted" style={{ fontSize: 12 }}>
        Use <b>Browse channels</b> to manage <code>channelIds</code>.
      </div>

      {modalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "grid",
            placeItems: "center",
            padding: 16,
            zIndex: 1000,
          }}
          onMouseDown={() => setModalOpen(false)}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation guard on the modal panel, not an interactive control */}
          <div
            className="card"
            style={{
              width: "min(980px, 96vw)",
              height: "min(82vh, 900px)",
              overflow: "hidden",
              display: "grid",
              gridTemplateRows: "auto auto 1fr",
              gap: 12,
              minHeight: 0,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "baseline",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 700 }}>Slack Channels</div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
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
                Close
              </button>
            </div>

            <div className="muted" style={{ fontSize: 12 }}>
              Selected IDs persist to <code>slack.channelIds</code>.{" "}
              {saving ? <b>Saving…</b> : null}
              {selectedIds.size === 0 ? (
                <span style={{ marginLeft: 8 }}>
                  (Note: Slack collector will error until at least one channel ID is selected.)
                </span>
              ) : null}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label
                className="muted"
                style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
              >
                <input
                  type="checkbox"
                  checked={onlyMember}
                  onChange={(e) => setOnlyMember(e.target.checked)}
                />
                Only show channels the bot is in
              </label>
              <div className="muted" style={{ fontSize: 12 }}>
                (If Slack shows <code>not_in_channel</code>, remove that ChannelID or invite the bot
                to it.)
              </div>
            </div>

            <div style={{ overflow: "auto", paddingRight: 6, minHeight: 0 }}>
              <div style={{ display: "grid", gap: 8 }}>
                {items.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {loading ? "Loading…" : "No channels to show."}
                  </div>
                ) : (
                  items.map((c) => {
                    const selected = selectedIds.has(c.id);
                    return (
                      <div
                        key={c.id}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 14,
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
                          <div style={{ fontWeight: 700 }}>#{c.name}</div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {c.isPrivate ? "private · " : "public · "}
                            {c.isMember ? "member" : "not a member"}
                            {c.isArchived ? " · archived" : ""}
                            {typeof c.numMembers === "number" ? ` · ${c.numMembers} members` : ""}
                          </div>
                        </div>

                        <div style={{ height: 8 }} />

                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <div className="muted" style={{ fontSize: 12 }}>
                            ChannelID: <code>{c.id}</code>
                          </div>
                          <button
                            type="button"
                            onClick={() => void toggleChannel(c.id)}
                            disabled={saving}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 12,
                              border: "1px solid var(--border)",
                              background: selected
                                ? "rgba(124,58,237,0.22)"
                                : "rgba(255,255,255,0.04)",
                              color: "var(--text)",
                              cursor: "pointer",
                              fontWeight: 700,
                              fontSize: 12,
                            }}
                            title={selected ? "Remove from channelIds" : "Add to channelIds"}
                          >
                            {selected ? "Remove" : "Add"}
                          </button>
                        </div>

                        {c.topic || c.purpose ? (
                          <div
                            className="muted"
                            style={{ marginTop: 8, fontSize: 12, whiteSpace: "pre-wrap" }}
                          >
                            {c.topic ? <>Topic: {c.topic}</> : null}
                            {c.topic && c.purpose ? <span> · </span> : null}
                            {c.purpose ? <>Purpose: {c.purpose}</> : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
