import { findNode } from "../lib/workflow.ts";
import { useErrorReporter } from "./use-error-reporter.ts";
import { useRunDetail } from "./use-run-detail.ts";
import { useScopedState } from "./use-scoped-state.ts";
import { useWorkflows } from "./use-workflows.ts";

/** Everything the App layout renders, with the state and effects kept out of the view. */
export function useStudio() {
  const errors = useErrorReporter();
  const library = useWorkflows(errors);
  const run = useRunDetail({
    slug: library.slug,
    loaded: library.workflow !== null,
    runs: library.runs,
    putRun: library.putRun,
    errors,
  });
  const [selectedNodeId, selectNode] = useScopedState<string | null>(library.slug, null);

  // With a run selected the graph shows that run's snapshot of the workflow,
  // which may differ from the saved definition.
  const viewedWorkflow = run.selectedRunId ? run.detail?.run.workflow : library.workflow;
  const node =
    viewedWorkflow && selectedNodeId ? findNode(viewedWorkflow.nodes, selectedNodeId) : undefined;

  function viewSavedDefinition() {
    run.selectRun(null);
    selectNode(null);
  }

  return {
    error: errors.message,
    dismissError: errors.clear,
    library,
    run,
    graph: { workflow: viewedWorkflow, node, selectedNodeId, selectNode, viewSavedDefinition },
  };
}
