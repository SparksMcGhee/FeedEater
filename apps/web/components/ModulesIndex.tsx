"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type ModuleManifest = {
  name: string;
  version: string;
  namespace: string;
  cards?: Array<{ id: string; title: string }>;
  settings?: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "secret";
    default?: unknown;
    required?: boolean;
  }>;
};

export function ModulesIndex() {
  const [modules, setModules] = useState<ModuleManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/modules", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load modules (${res.status})`);
        const data = (await res.json()) as { modules: ModuleManifest[] };
        if (cancelled) return;
        setModules(data.modules ?? []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(
    () =>
      (modules ?? [])
        .slice()
        .sort((a: ModuleManifest, b: ModuleManifest) => a.name.localeCompare(b.name)),
    [modules],
  );
  const sortedTyped = sorted as ModuleManifest[];

  if (error) {
    return (
      <div className="card">
        <div style={{ fontSize: 20, fontWeight: 700 }}>Modules</div>
        <div style={{ height: 8 }} />
        <div className="muted">Failed to load: {error}</div>
      </div>
    );
  }

  if (!modules) {
    return (
      <div className="card">
        <div style={{ fontSize: 20, fontWeight: 700 }}>Modules</div>
        <div style={{ height: 8 }} />
        <div className="muted">Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="card">
        <div style={{ fontSize: 20, fontWeight: 700 }}>Modules</div>
        <div style={{ height: 8 }} />
        <div className="muted">
          Pick a module to view its cards and edit settings. Adding a module should be as simple as
          dropping a folder into <code>modules/</code>.
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {sortedTyped.length === 0 ? (
          <div className="card">
            <div className="muted">No modules found.</div>
          </div>
        ) : (
          sortedTyped.map((m: ModuleManifest) => (
            <Link
              key={m.name}
              href={`/modules/${encodeURIComponent(m.name)}`}
              className="card"
              style={{ display: "block" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "baseline",
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 700 }}>{m.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  v{m.version}
                </div>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                {m.namespace}
              </div>
              <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                Cards: {m.cards?.length ?? 0} · Settings: {m.settings?.length ?? 0}
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
