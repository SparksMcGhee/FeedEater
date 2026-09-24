"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SlackChannelsCard } from "./cards/SlackChannelsCard";
import { ModuleSettingsEditor } from "./ModuleSettingsEditor";
import { ModuleTabs } from "./ModuleTabs";

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

type ModuleSettingsResponse = {
  module: string;
  settings: Array<{ key: string; isSecret: boolean; value: string | null }>;
};

export function ModulePage(props: { moduleName: string }) {
  const [modules, setModules] = useState<ModuleManifest[] | null>(null);
  const [settings, setSettings] = useState<ModuleSettingsResponse | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings/${encodeURIComponent(props.moduleName)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
        const data = (await res.json()) as ModuleSettingsResponse;
        if (cancelled) return;
        setSettings(data);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.moduleName]);

  const module = useMemo(
    () => modules?.find((m: ModuleManifest) => m.name === props.moduleName) ?? null,
    [modules, props.moduleName],
  );
  const sortedModules = useMemo(
    () =>
      (modules ?? [])
        .slice()
        .sort((a: ModuleManifest, b: ModuleManifest) => a.name.localeCompare(b.name)),
    [modules],
  );

  if (error) {
    return (
      <div className="card">
        <div style={{ fontSize: 20, fontWeight: 700 }}>Modules</div>
        <div style={{ height: 8 }} />
        <div className="muted">Error: {error}</div>
      </div>
    );
  }

  if (!modules || !module || !settings) {
    return (
      <div className="card">
        <div style={{ fontSize: 20, fontWeight: 700 }}>Modules</div>
        <div style={{ height: 8 }} />
        <div className="muted">Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "baseline",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700 }}>{module.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            v{module.version}
          </div>
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          {module.namespace}
        </div>
        <div style={{ height: 12 }} />
        <ModuleTabs
          modules={sortedModules.map((m: ModuleManifest) => ({ name: m.name }))}
          current={module.name}
        />
        <div style={{ height: 10 }} />
        <Link href="/modules" className="muted" style={{ fontSize: 12 }}>
          ← Back to modules list
        </Link>
      </div>

      <div className="card">
        <div style={{ fontSize: 16, fontWeight: 700 }}>Cards</div>
        <div style={{ height: 10 }} />
        {module.cards?.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {module.cards.map((c: { id: string; title: string }) => (
              <div
                key={c.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  padding: 12,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <div style={{ fontWeight: 700 }}>{c.title}</div>
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  Card id: <code>{c.id}</code>
                </div>
                {module.name === "slack" && c.id === "slackChannels" ? (
                  <div style={{ marginTop: 10 }}>
                    <SlackChannelsCard />
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                    (This card is not yet wired to a UI widget.)
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">This module defines no cards.</div>
        )}
      </div>

      <ModuleSettingsEditor
        moduleName={module.name}
        settings={module.settings ?? []}
        initialValues={settings.settings}
      />
    </div>
  );
}
