import type { WorkflowSummary } from "./api.ts";
import { shortDate } from "./format.ts";

export function WorkflowRail({
  summaries,
  selectedSlug,
  onSelect,
  cwd,
  onRefresh,
  refreshing,
}: {
  summaries: WorkflowSummary[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  cwd: string;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}) {
  return (
    <aside className="workflow-rail" aria-label="Saved workflows">
      <div className="rail-head">
        <h2>Saved workflows</h2>
        <div className="rail-actions">
          <span>{summaries.length}</span>
          <button type="button" onClick={() => void onRefresh()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {summaries.length === 0 ? (
        <p className="empty-note">
          No workflows saved. Run <code>loopy save &lt;file.ts&gt;</code> to add one.
        </p>
      ) : (
        <div className="workflow-list">
          {summaries.map((item) => (
            <button
              type="button"
              key={item.slug}
              onClick={() => onSelect(item.slug)}
              className={`workflow-item${selectedSlug === item.slug ? " active" : ""}`}
              aria-current={selectedSlug === item.slug ? "page" : undefined}
            >
              <strong>{item.slug}</strong>
              {item.description && <span>{item.description}</span>}
              <small>
                {item.nodeCount} {item.nodeCount === 1 ? "step" : "steps"} ·{" "}
                {shortDate(item.updatedAt)}
              </small>
            </button>
          ))}
        </div>
      )}
      <div className="rail-foot">
        <span>Working directory</span>
        <code title={cwd}>{cwd || "Loading..."}</code>
      </div>
    </aside>
  );
}
