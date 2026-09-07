import type { WorkflowNode } from "@loopy/contracts";
import {
  CheckCircle,
  GitBranch,
  Hand,
  Intersect,
  Robot,
  TerminalWindow,
  TreeStructure,
} from "@phosphor-icons/react";
import { useState } from "react";

export const steps = [
  { kind: "agent", title: "Agent call", detail: "Give an installed agent a task", icon: Robot },
  {
    kind: "shell",
    title: "Shell module",
    detail: "Pipe Bash commands together",
    icon: TerminalWindow,
  },
  { kind: "route", title: "Condition", detail: "Choose a branch from a result", icon: GitBranch },
  {
    kind: "verify",
    title: "Verification",
    detail: "Check the work with commands",
    icon: CheckCircle,
  },
  { kind: "approval", title: "Approval", detail: "Wait for a human decision", icon: Hand },
  { kind: "join", title: "Join", detail: "Collect completed branches", icon: Intersect },
  {
    kind: "transform",
    title: "Transform",
    detail: "Map values between steps",
    icon: TreeStructure,
  },
] as const;

export function StepLibrary({ onAdd }: { onAdd: (kind: WorkflowNode["kind"]) => void }) {
  const [search, setSearch] = useState("");
  return (
    <aside className="step-library" aria-label="Step library">
      <header>
        <span className="editor-eyebrow">Add step</span>
        <h2>Step library</h2>
      </header>
      <input
        aria-label="Search steps"
        placeholder="Search steps"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="step-library-items">
        {steps
          .filter((step) =>
            `${step.title} ${step.detail}`.toLowerCase().includes(search.toLowerCase()),
          )
          .map(({ kind, title, detail, icon: Icon }) => (
            <button
              type="button"
              className="palette-action"
              key={kind}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("application/loopy-step", kind);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(kind)}
            >
              <span className="palette-action-icon">
                <Icon size={17} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
      </div>
      <footer>Click a step or drag it onto the canvas. Work runs on your computer.</footer>
    </aside>
  );
}
