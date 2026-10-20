import type { StepRecord } from "loopy/contract";
import type { CanvasFrame } from "./canvas-page.tsx";
import { StepRow } from "./step-row.tsx";

/** Recorded execution order only. Legacy history cannot supply static graph topology. */
export function RunTrace({
  steps,
  now,
  frame,
}: {
  steps: StepRecord[];
  now: number;
  frame: CanvasFrame;
}) {
  return (
    <div
      className="absolute inset-0 overflow-y-auto"
      style={{
        paddingTop: frame.padding.top,
        paddingRight: frame.padding.right,
        paddingBottom: frame.padding.bottom,
        paddingLeft: frame.padding.left,
      }}
    >
      <section
        aria-labelledby="trace-heading"
        className="float mx-auto w-full max-w-4xl space-y-4 p-4 max-md:mt-24"
      >
        <header className="space-y-1 border-b border-line pb-3">
          <h2 id="trace-heading" className="font-medium">
            Executed steps <span className="font-mono text-xs text-muted">{steps.length}</span>
          </h2>
          <p className="text-xs text-muted">
            Static graph unavailable for this legacy TypeScript workflow.
          </p>
        </header>
        {steps.length === 0 ? (
          <p className="text-sm text-muted">No steps recorded.</p>
        ) : (
          <ol className="space-y-4">
            {[...steps]
              .sort((a, b) => a.seq - b.seq)
              .map((step) => (
                <li key={step.seq} className="grid grid-cols-[2rem_minmax(0,1fr)]">
                  <span className="pt-2 font-mono text-xs text-muted">{step.seq}</span>
                  <StepRow step={step} now={now} />
                </li>
              ))}
          </ol>
        )}
      </section>
    </div>
  );
}
