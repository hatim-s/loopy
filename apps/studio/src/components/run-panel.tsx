import type { RunRecord } from "loopy";
import type { RunDetail } from "../api.ts";
import { shortDate, shortId } from "../lib/format.ts";
import { RunDetailView } from "./run-detail.tsx";

type RunPanelProps = {
  runs: RunRecord[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  detail: RunDetail | null;
  onResume: (retryUncertain: boolean) => Promise<void>;
  busy: boolean;
};

export function RunPanel({ runs, selectedRunId, onSelect, detail, onResume, busy }: RunPanelProps) {
  return (
    <section className="runs-section">
      <div className="section-heading">
        <h3>Runs</h3>
        <span>{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="empty-note">No runs yet. Enter JSON and run this workflow.</p>
      ) : (
        <div className="run-list">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`run-item${selectedRunId === run.id ? " active" : ""}`}
              onClick={() => onSelect(run.id)}
              aria-pressed={selectedRunId === run.id}
            >
              <span className={`status ${run.status}`}>{run.status}</span>
              <span className="run-id">{shortId(run.id)}</span>
              <time>{shortDate(run.createdAt)}</time>
            </button>
          ))}
        </div>
      )}
      {selectedRunId && !detail && <p className="empty-note">Loading run...</p>}
      {detail && <RunDetailView detail={detail} busy={busy} onResume={onResume} />}
    </section>
  );
}
