import type { RunStatus, Workflow } from "loopy";
import { latestAttempts } from "loopy";
import { useMemo } from "react";
import type { RunDetail } from "../api.ts";
import { GraphSequence } from "./graph-sequence.tsx";

const END_LABELS: Partial<Record<RunStatus, string>> = {
  succeeded: "Complete",
  failed: "Failed",
  interrupted: "Interrupted",
};

type GraphProps = {
  workflow: Workflow;
  detail: RunDetail | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSavedDefinition: () => void;
};

export function Graph({ workflow, detail, selectedId, onSelect, onSavedDefinition }: GraphProps) {
  const attempts = useMemo(() => latestAttempts(detail?.attempts ?? []), [detail]);
  const status = detail?.run.status;
  return (
    <section className="graph-pane" aria-label="Workflow graph">
      <div className="pane-heading">
        <div>
          <h2>Workflow graph</h2>
          <p>Select a step to inspect its command and run attempts.</p>
        </div>
        <div className="graph-view">
          <span>{detail ? "Run snapshot" : "Saved definition"}</span>
          {detail && (
            <button type="button" onClick={onSavedDefinition}>
              View saved definition
            </button>
          )}
        </div>
      </div>
      <div className="graph-scroll">
        <div className="graph-canvas">
          <div className="graph-start">Trigger</div>
          <div className="graph-link" aria-hidden="true" />
          <GraphSequence
            nodes={workflow.nodes}
            attempts={attempts}
            selectedId={selectedId}
            onSelect={onSelect}
          />
          <div className="graph-link" aria-hidden="true" />
          <div className={`graph-end ${status ?? ""}`}>
            {(status && END_LABELS[status]) ?? "End"}
          </div>
        </div>
      </div>
    </section>
  );
}
