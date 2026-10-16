import { BrandMark } from "./components/brand-mark.tsx";
import { ErrorBanner } from "./components/error-banner.tsx";
import { RunDetail } from "./components/run-detail.tsx";
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
      </header>
      {state.error && <ErrorBanner message={state.error} onDismiss={state.dismissError} />}
      <div className="studio-columns">
        <nav aria-label="Saved loopies">
          <h1>Registry</h1>
          {state.loopies.length === 0 && <p>Save a loopy with loopy save &lt;file.ts&gt;.</p>}
          {state.loopies.map((loopy) => (
            <button
              type="button"
              key={loopy.slug}
              aria-pressed={state.slug === loopy.slug}
              onClick={() => state.selectSlug(loopy.slug)}
            >
              <strong>{loopy.slug}</strong>
              <span>{loopy.description}</span>
            </button>
          ))}
        </nav>
        <nav aria-label="Runs">
          <h2>Runs</h2>
          <p>{state.slug ?? "Select a loopy to see its runs."}</p>
          {state.slug && state.runs.length === 0 && <p>No runs yet. Use loopy run {state.slug}.</p>}
          {state.runs.map((run) => (
            <button
              type="button"
              key={run.id}
              aria-pressed={state.runId === run.id}
              onClick={() => state.selectRun(run.id)}
            >
              <strong>{run.status}</strong>
              <span>{run.id}</span>
              <time>{run.createdAt}</time>
            </button>
          ))}
        </nav>
        <main>
          {state.detail ? (
            <RunDetail detail={state.detail} />
          ) : (
            <p>Select a run to see its step trace and logs.</p>
          )}
        </main>
      </div>
    </div>
  );
}
