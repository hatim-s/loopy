import { BrandMark } from "./components/brand-mark.tsx";
import { ErrorBanner } from "./components/error-banner.tsx";
import { LoopyRail } from "./components/loopy-rail.tsx";
import { RunDetail } from "./components/run-detail.tsx";
import { RunList } from "./components/run-list.tsx";
import { useStudio } from "./hooks/use-studio.ts";

export function App() {
  const state = useStudio();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <BrandMark />
          <strong>loopy</strong>
          <span>Studio</span>
        </div>
        <button type="button" onClick={state.refresh}>
          Refresh
        </button>
      </header>
      {state.error && <ErrorBanner message={state.error} onDismiss={state.dismissError} />}
      <div className="studio-columns">
        <LoopyRail
          loopies={state.loopies}
          runs={state.allRuns}
          selected={state.slug}
          onSelect={state.selectSlug}
        />
        <RunList
          runs={state.runs}
          slug={state.slug}
          selected={state.runId}
          onSelect={state.selectRun}
        />
        <main>
          {state.detail ? (
            <RunDetail detail={state.detail} />
          ) : (
            <p className="empty-state">
              {state.runId ? "Loading run…" : "Select a run to see its step trace and logs."}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
