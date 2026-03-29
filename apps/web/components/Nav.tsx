import Link from "next/link";

const linkStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "rgba(255,255,255,0.04)",
};

export function Nav() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ fontWeight: 700, letterSpacing: 0.4 }}>FeedEater</div>
        <div className="muted" style={{ fontSize: 13 }}>
          port 666
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Link href="/" style={linkStyle}>
          Dashboard
        </Link>
        <Link href="/modules" style={linkStyle}>
          Modules
        </Link>
        <Link href="/jobs" style={linkStyle}>
          Jobs
        </Link>
        <Link href="/narratives" style={linkStyle}>
          Narratives
        </Link>
        <Link href="/logs" style={linkStyle}>
          Logs
        </Link>
      </div>
    </div>
  );
}


