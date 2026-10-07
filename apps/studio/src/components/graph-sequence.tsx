import type { AttemptRecord, WorkflowNode } from "loopy";
import { describe, selectedBranch } from "../lib/workflow.ts";

type GraphSequenceProps = {
  nodes: WorkflowNode[];
  attempts: Map<string, AttemptRecord>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  inactive?: boolean;
};

type BranchArmProps = GraphSequenceProps & {
  label: string;
  taken: boolean | undefined;
};

function BranchArm({ label, taken, ...sequence }: BranchArmProps) {
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

function nodeSummary(node: WorkflowNode): string {
  if (node.kind === "condition") {
    return describe(node.test);
  }
  return `${node.command.program} ${node.command.args.map(describe).join(" ")}`;
}

export function GraphSequence({
  nodes,
  attempts,
  selectedId,
  onSelect,
  inactive = false,
}: GraphSequenceProps) {
  if (nodes.length === 0) {
    return <div className="graph-empty">No steps</div>;
  }
  return (
    <div className={`graph-sequence${inactive ? " graph-sequence-inactive" : ""}`}>
      {nodes.map((node, index) => {
        const attempt = attempts.get(node.id);
        const branch = node.kind === "condition" ? selectedBranch(attempt) : undefined;
        const selected = selectedId === node.id;
        const arm = { attempts, selectedId, onSelect };
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
                <small>{nodeSummary(node)}</small>
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
                    inactive={inactive || branch === "else"}
                    {...arm}
                  />
                  <BranchArm
                    label="Else"
                    taken={branch && branch === "else"}
                    nodes={node.else}
                    inactive={inactive || branch === "then"}
                    {...arm}
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
