import { LiveNarrativesFeed } from "../../components/LiveNarrativesFeed";

export default function NarrativesPage() {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>Narratives</div>
      <LiveNarrativesFeed />
    </div>
  );
}
