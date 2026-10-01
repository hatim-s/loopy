import type { RunStatus, WorkflowNode } from "loopy";
import { useMemo } from "react";
import type { AttemptRecord, RunDetail, Workflow } from "./api.ts";
import { describe, latestAttempts, selectedBranch } from "./format.ts";

type SequenceProps = {
  nodes: WorkflowNode[];
  attempts: Map<string, AttemptRecord>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  inactive?: boolean;
};

function BranchArm({
  label,
  taken,
  ...sequence
}: SequenceProps & { label: string; taken: boolean | undefined }) {
  const state = taken === true ? " taken" : taken === false ? " skipped" : "";
  return (
    <div className={`branch-arm${state}`}>
      <div className="branch-label">
        <span>{label}</span>
        {taken && <span>Taken</span>}
      </div>
      <GraphSequence {...sequence} />
    </div>
  );
}

function GraphSequence({ nodes, attempts, selectedId, onSelect, inactive = false }: SequenceProps) {
  if (nodes.length === 0) return <div className="graph-empty">No steps</div>;
  return (
    <div className={`graph-sequence${inactive ? " graph-sequence-inactive" : ""}`}>
      {nodes.map((node, index) => {
        const attempt = attempts.get(node.id);
        const branch = node.kind === "condition" ? selectedBranch(attempt) : undefined;
        const selected = selectedId === node.id;
        return (
          <div className="graph-step" key={node.id}>
            <button
              type="button"
              className={`graph-node ${node.kind} ${attempt?.status ?? "idle"}${selected ? " selected" : ""}`}
              onClick={() => onSelect(node.id)}
              aria-pressed={selected}
              title={node.id}
            >
              <span className="node-icon" aria-hidden="true">
                {node.kind === "condition" ? "◇" : ">_"}
              </span>
              <span className="node-copy">
                <strong>{node.id}</strong>
                <small>
                  {node.kind === "condition"
                    ? describe(node.test)
                    : `${node.command.program} ${node.command.args.map(describe).join(" ")}`}
                </small>
              </span>
              {attempt && (
                <span className={`node-state ${attempt.status}`} title={attempt.status} />
              )}
            </button>
            {node.kind === "condition" && (
              <div className="branch-layout">
                <div className="branch-rail" aria-hidden="true" />
                <div className="branch-columns">
                  <BranchArm
                    label="Then"
                    taken={branch && branch === "then"}
                    nodes={node.then}
                    attempts={attempts}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    inactive={inactive || branch === "else"}
                  />
                  <BranchArm
                    label="Else"
                    taken={branch && branch === "else"}
                    nodes={node.else}
                    attempts={attempts}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    inactive={inactive || branch === "then"}
                  />
                </div>
                <div className="branch-join">
                  <span>Join</span>
                </div>
              </div>
            )}
            {index < nodes.length - 1 && <div className="graph-link" aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}

const endLabels: Partial<Record<RunStatus, string>> = {
  succeeded: "Complete",
  failed: "Failed",
  interrupted: "Interrupted",
};

export function Graph({
  workflow,
  detail,
  selectedId,
  onSelect,
  onSavedDefinition,
}: {
  workflow: Workflow;
  detail: RunDetail | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSavedDefinition: () => void;
}) {
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
            {(status && endLabels[status]) ?? "End"}
          </div>
        </div>
      </div>
    </section>
  );
}
