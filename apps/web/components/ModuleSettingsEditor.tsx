"use client";

import { useMemo, useState } from "react";

type SettingDef = {
  key: string;
  type: "string" | "number" | "boolean" | "secret";
  default?: unknown;
  required?: boolean;
};

type SettingValue = { key: string; isSecret: boolean; value: string | null };

export function ModuleSettingsEditor(props: {
  moduleName: string;
  settings: SettingDef[];
  initialValues: SettingValue[];
}) {
  const initialByKey = useMemo(() => {
    const m = new Map<string, SettingValue>();
    for (const s of props.initialValues) m.set(s.key, s);
    return m;
  }, [props.initialValues]);

  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const def of props.settings) {
      const existing = initialByKey.get(def.key);
      if (existing && existing.value !== null) d[def.key] = existing.value;
      else if (typeof def.default === "string") d[def.key] = def.default;
      else d[def.key] = "";
    }
    return d;
  });
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});
  const [error, setError] = useState<Record<string, string>>({});

  async function saveOne(def: SettingDef) {
    setSaving((p: Record<string, boolean>) => ({ ...p, [def.key]: true }));
    setError((p: Record<string, string>) => ({ ...p, [def.key]: "" }));
    try {
      const value = draft[def.key] ?? "";
      const res = await fetch(
        `/api/settings/${encodeURIComponent(props.moduleName)}/${encodeURIComponent(def.key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value,
            isSecret: def.type === "secret",
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Save failed (${res.status}) ${body}`);
      }
      setSavedAt((p: Record<string, string>) => ({
        ...p,
        [def.key]: new Date().toLocaleTimeString(),
      }));
    } catch (e) {
      setError((p: Record<string, string>) => ({
        ...p,
        [def.key]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setSaving((p: Record<string, boolean>) => ({ ...p, [def.key]: false }));
    }
  }

  if (!props.settings.length) {
    return (
      <div className="card">
        <div style={{ fontSize: 16, fontWeight: 700 }}>Settings</div>
        <div style={{ height: 8 }} />
        <div className="muted">This module has no settings.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ fontSize: 16, fontWeight: 700 }}>Settings</div>
      <div style={{ height: 12 }} />

      <div style={{ display: "grid", gap: 12 }}>
        {props.settings.map((def) => {
          const isSecret = def.type === "secret";
          const existing = initialByKey.get(def.key);
          const valueKnown = existing?.value !== null && existing?.value !== undefined;
          const placeholder = isSecret
            ? valueKnown
              ? "(secret set)"
              : "(unset)"
            : def.default !== undefined
              ? `default: ${String(def.default)}`
              : "";

          return (
            <div
              key={def.key}
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
                <div style={{ fontWeight: 700 }}>{def.key}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {def.type}
                  {def.required ? " · required" : ""}
                </div>
              </div>

              <div style={{ height: 10 }} />

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type={isSecret ? "password" : "text"}
                  value={draft[def.key] ?? ""}
                  placeholder={placeholder}
                  onChange={(e) =>
                    setDraft((p: Record<string, string>) => ({
                      ...p,
                      [def.key]: (e.target as any).value,
                    }))
                  }
                  style={{
                    flex: "1 1 340px",
                    minWidth: 260,
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid var(--border)",
                    background: "rgba(0,0,0,0.2)",
                    color: "var(--text)",
                    outline: "none",
                  }}
                />

                <button
                  type="button"
                  onClick={() => void saveOne(def)}
                  disabled={Boolean(saving[def.key])}
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
                  {saving[def.key] ? "Saving…" : "Save"}
                </button>
              </div>

              {error[def.key] ? (
                <div style={{ marginTop: 8, color: "rgba(255,120,120,0.9)", fontSize: 12 }}>
                  {error[def.key]}
                </div>
              ) : null}

              {savedAt[def.key] ? (
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Saved at {savedAt[def.key]}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
