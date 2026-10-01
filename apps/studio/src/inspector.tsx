import type { WorkflowNode } from "loopy";
import type { AttemptRecord, RunDetail } from "./api.ts";
import { describe, formatted, outputText, selectedBranch, shortDate } from "./format.ts";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      {children}
    </div>
  );
}

function CommandDefinition({ node }: { node: Extract<WorkflowNode, { kind: "command" }> }) {
  const { command } = node;
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

function ConditionDefinition({ node }: { node: Extract<WorkflowNode, { kind: "condition" }> }) {
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

export function NodeInspector({
  node,
  detail,
}: {
  node: WorkflowNode | undefined;
  detail: RunDetail | null;
}) {
  if (!node)
    return (
      <section className="inspector-section">
        <div className="section-heading">
          <h3>Step</h3>
        </div>
        <p className="empty-note">Select a step in the graph to see its definition.</p>
      </section>
    );
  const attempts = detail?.attempts.filter((attempt) => attempt.nodeId === node.id) ?? [];
  return (
    <section className="inspector-section">
      <div className="section-heading">
        <h3>{node.id}</h3>
        <span>{node.kind}</span>
      </div>
      {node.kind === "command" ? (
        <CommandDefinition node={node} />
      ) : (
        <ConditionDefinition node={node} />
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

export function Attempt({ attempt }: { attempt: AttemptRecord }) {
  const stdout = outputText(attempt.output, "stdout");
  const stderr = outputText(attempt.output, "stderr");
  const branch = selectedBranch(attempt);
  return (
    <div className="attempt">
      <div className="attempt-head">
        <span>Attempt {attempt.number}</span>
        <span className={`status ${attempt.status}`}>{attempt.status}</span>
      </div>
      <small>
        {shortDate(attempt.startedAt)}
        {attempt.endedAt ? ` → ${shortDate(attempt.endedAt)}` : ""}
      </small>
      <details className="attempt-input">
        <summary>Input</summary>
        <pre>{formatted(attempt.input)}</pre>
      </details>
      {branch && (
        <p>
          Selected <strong>{branch}</strong> branch
        </p>
      )}
      {attempt.error && <pre className="error-output">{attempt.error}</pre>}
      {stdout && (
        <div className="stream">
          <span>stdout</span>
          <pre>{stdout}</pre>
        </div>
      )}
      {stderr && (
        <div className="stream">
          <span>stderr</span>
          <pre>{stderr}</pre>
        </div>
      )}
      {!stdout && !stderr && attempt.output !== undefined && !branch && (
        <div className="stream">
          <span>Output</span>
          <pre>{formatted(attempt.output)}</pre>
        </div>
      )}
    </div>
  );
}
