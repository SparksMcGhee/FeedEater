import { JobsRunPanel } from "../../components/JobsRunPanel";

export default function JobsPage() {
  return (
    <div className="card">
      <div style={{ fontSize: 20, fontWeight: 700 }}>Jobs</div>
      <div style={{ height: 8 }} />
      <div className="muted">Manual run controls and recent status for module jobs.</div>

      <JobsRunPanel />
    </div>
  );
}
