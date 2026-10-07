import type { CommandNode, ConditionNode, WorkflowNode } from "loopy";
import type { ReactNode } from "react";
import type { RunDetail } from "../api.ts";
import { formatted } from "../lib/format.ts";
import { describe } from "../lib/workflow.ts";
import { Attempt } from "./attempt.tsx";

type FieldProps = {
  label: string;
  children: ReactNode;
};

function Field({ label, children }: FieldProps) {
  return (
    <div>
      <span>{label}</span>
      {children}
    </div>
  );
}

function CommandDefinition({ command }: CommandNode) {
  return (
    <div className="definition">
      <Field label="Program">
        <code>{command.program}</code>
      </Field>
      <Field label="Arguments">
        <pre>{command.args.length ? command.args.map(describe).join(" ") : "None"}</pre>
      </Field>
      {command.cwd && (
        <Field label="Directory">
          <code>{command.cwd}</code>
        </Field>
      )}
      {command.stdin !== undefined && (
        <Field label="Standard input">
          <pre>{describe(command.stdin)}</pre>
        </Field>
      )}
      {command.env && (
        <Field label="Environment">
          <pre>{formatted(command.env)}</pre>
        </Field>
      )}
      {command.timeoutMs && (
        <Field label="Timeout">
          <code>{command.timeoutMs} ms</code>
        </Field>
      )}
    </div>
  );
}

function ConditionDefinition(node: ConditionNode) {
  return (
    <div className="definition">
      <Field label="Condition">
        <pre>{describe(node.test)}</pre>
      </Field>
      <Field label="Then">
        <code>{node.then.length} steps</code>
      </Field>
      <Field label="Else">
        <code>{node.else.length} steps</code>
      </Field>
    </div>
  );
}

type NodeInspectorProps = {
  node: WorkflowNode | undefined;
  detail: RunDetail | null;
};

export function NodeInspector({ node, detail }: NodeInspectorProps) {
  if (!node) {
    return (
      <section className="inspector-section">
        <div className="section-heading">
          <h3>Step</h3>
        </div>
        <p className="empty-note">Select a step in the graph to see its definition.</p>
      </section>
    );
  }
  const attempts = detail?.attempts.filter((attempt) => attempt.nodeId === node.id) ?? [];
  return (
    <section className="inspector-section">
      <div className="section-heading">
        <h3>{node.id}</h3>
        <span>{node.kind}</span>
      </div>
      {node.kind === "command" ? (
        <CommandDefinition {...node} />
      ) : (
        <ConditionDefinition {...node} />
      )}
      {detail && (
        <div className="node-attempts">
          <h4>Attempts in this run</h4>
          {attempts.length === 0 ? (
            <p className="empty-note">This step has not run.</p>
          ) : (
            attempts.map((attempt) => <Attempt key={attempt.id} attempt={attempt} />)
          )}
        </div>
      )}
    </section>
  );
}
