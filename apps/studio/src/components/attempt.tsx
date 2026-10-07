import type { AttemptRecord } from "loopy";
import { formatted, shortDate } from "../lib/format.ts";
import { outputText, selectedBranch } from "../lib/workflow.ts";

type AttemptProps = {
  attempt: AttemptRecord;
};

export function Attempt({ attempt }: AttemptProps) {
  const stdout = outputText(attempt.output, "stdout");
  const stderr = outputText(attempt.output, "stderr");
  const branch = selectedBranch(attempt);
  // Command output is shown as streams; anything else falls back to raw JSON.
  const rawOutput = !stdout && !stderr && !branch && attempt.output !== undefined;
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
      {rawOutput && (
        <div className="stream">
          <span>Output</span>
          <pre>{formatted(attempt.output)}</pre>
        </div>
      )}
    </div>
  );
}
