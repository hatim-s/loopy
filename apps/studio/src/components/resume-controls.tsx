import { useState } from "react";

type ResumeControlsProps = {
  uncertainCount: number;
  busy: boolean;
  onResume: (retryUncertain: boolean) => Promise<void>;
};

export function ResumeControls({ uncertainCount, busy, onResume }: ResumeControlsProps) {
  const [retryUncertain, setRetryUncertain] = useState(false);
  return (
    <div className="resume-controls">
      {uncertainCount > 0 && (
        <>
          <label>
            <input
              type="checkbox"
              checked={retryUncertain}
              onChange={(event) => setRetryUncertain(event.target.checked)}
            />
            Retry {uncertainCount} uncertain {uncertainCount === 1 ? "step" : "steps"}
          </label>
          <p>
            These steps may have finished before Loopy stopped. Retrying can repeat their side
            effects.
          </p>
        </>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => void onResume(retryUncertain)}
      >
        {busy ? "Resuming..." : "Resume run"}
      </button>
    </div>
  );
}
