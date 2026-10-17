import type { RunView } from "loopy/contract";
import { JsonPreview } from "./json-preview.tsx";

export function RunIo({ run }: { run: RunView }) {
  return (
    <section aria-label="Input and output" className="space-y-1.5">
      <JsonPreview label="Input" value={run.input} />
      {run.status === "succeeded" && <JsonPreview label="Output" value={run.output} />}
      {run.status === "failed" && (
        <pre role="alert" className="font-mono text-xs whitespace-pre-wrap text-danger">
          {run.error}
        </pre>
      )}
    </section>
  );
}
