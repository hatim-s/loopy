import { BrandMark } from "./components/brand-mark.tsx";
import { ErrorBanner } from "./components/error-banner.tsx";
import { Graph } from "./components/graph.tsx";
import { NodeInspector } from "./components/node-inspector.tsx";
import { RunForm } from "./components/run-form.tsx";
import { RunPanel } from "./components/run-panel.tsx";
import { WorkflowRail } from "./components/workflow-rail.tsx";
import { useStudio } from "./hooks/use-studio.ts";

export function App() {
  const { error, dismissError, library, run, graph } = useStudio();
  const { workflow, slug } = library;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <strong>loopy</strong>
          <span>Studio</span>
        </div>
        <div className="header-context">
          Local workflows <span aria-hidden="true">/</span> {slug ?? "No workflow"}
        </div>
      </header>
      {error && <ErrorBanner message={error} onDismiss={dismissError} />}
      <div className="workspace">
        <WorkflowRail
          summaries={library.summaries}
          selectedSlug={slug}
          onSelect={library.selectSlug}
          cwd={library.cwd}
          onRefresh={library.refresh}
          refreshing={library.refreshing}
        />
        {workflow ? (
          <>
            {graph.workflow ? (
              <Graph
                workflow={graph.workflow}
                detail={run.detail}
                selectedId={graph.selectedNodeId}
                onSelect={graph.selectNode}
                onSavedDefinition={graph.viewSavedDefinition}
              />
            ) : (
              <div className="graph-pane graph-loading">Loading run snapshot...</div>
            )}
            <aside className="inspector" aria-label="Workflow details">
              <NodeInspector node={graph.node} detail={run.detail} />
              <RunForm key={workflow.slug} slug={workflow.slug} onRun={run.start} busy={run.busy} />
              <RunPanel
                key={run.selectedRunId}
                runs={library.runs}
                selectedRunId={run.selectedRunId}
                onSelect={run.selectRun}
                detail={run.detail}
                onResume={run.resume}
                busy={run.busy}
              />
            </aside>
          </>
        ) : (
          <main className="main-empty">
            <h1>{slug ? "Loading workflow..." : "No workflow selected"}</h1>
            <p>
              {slug
                ? "Reading its definition and run history."
                : "Save a TypeScript workflow to see its graph here."}
            </p>
          </main>
        )}
      </div>
    </div>
  );
}
