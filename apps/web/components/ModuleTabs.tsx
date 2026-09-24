"use client";

import Link from "next/link";

export function ModuleTabs(props: { modules: Array<{ name: string }>; current: string }) {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {props.modules.map((m) => {
        const active = m.name === props.current;
        return (
          <Link
            key={m.name}
            href={`/modules/${encodeURIComponent(m.name)}`}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid var(--border)",
              background: active ? "rgba(124,58,237,0.22)" : "rgba(255,255,255,0.04)",
              fontWeight: active ? 700 : 500,
            }}
          >
            {m.name}
          </Link>
        );
      })}
    </div>
  );
}
