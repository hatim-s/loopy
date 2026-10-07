import type { RunRecord, Workflow, WorkflowSummary } from "loopy";
import { useEffect, useState } from "react";
import { endpoints } from "../api.ts";
import type { ErrorReporter } from "./use-error-reporter.ts";
import { useRequest } from "./use-request.ts";

type Loaded = { slug: string; workflow: Workflow; runs: RunRecord[] };

function newestFirst(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pickSlug(items: WorkflowSummary[], wanted: string | null): string | null {
  return items.find((item) => item.slug === wanted)?.slug ?? items[0]?.slug ?? null;
}

async function loadLibrary() {
  const [summaries, config] = await Promise.all([endpoints.workflows(), endpoints.config()]);
  return { summaries, cwd: config.cwd };
}

async function loadWorkflow(slug: string): Promise<Loaded> {
  const [workflow, runs] = await Promise.all([endpoints.workflow(slug), endpoints.runs(slug)]);
  return { slug, workflow, runs: newestFirst(runs) };
}

/** The saved-workflow list, the selected slug, and that workflow's definition and run history. */
export function useWorkflows(errors: ErrorReporter) {
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [cwd, setCwd] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Whatever was loaded for a previous slug stays hidden while the new one loads.
  const current = loaded?.slug === slug ? loaded : null;

  useRequest(
    {
      load: loadLibrary,
      apply: (library) => {
        setSummaries(library.summaries);
        setCwd(library.cwd);
        const requested = new URLSearchParams(window.location.search).get("workflow");
        setSlug(pickSlug(library.summaries, requested));
      },
      onError: errors.report,
    },
    [],
  );

  useRequest(
    {
      load: slug ? () => loadWorkflow(slug) : null,
      apply: (next) => {
        setLoaded(next);
        errors.clear();
      },
      onError: errors.report,
    },
    [slug],
  );

  // Keep the slug in the URL so a reload opens the same workflow.
  useEffect(() => {
    if (!slug) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("workflow", slug);
    history.replaceState(null, "", url);
  }, [slug]);

  /** Replaces a known run in place, or puts a new one at the top. */
  function putRun(run: RunRecord) {
    setLoaded((previous) => {
      if (!previous || previous.slug !== run.slug) {
        return previous;
      }
      const known = previous.runs.some((item) => item.id === run.id);
      const runs = known
        ? previous.runs.map((item) => (item.id === run.id ? run : item))
        : [run, ...previous.runs];
      return { ...previous, runs };
    });
  }

  async function refresh() {
    setRefreshing(true);
    errors.clear();
    try {
      const library = await loadLibrary();
      setSummaries(library.summaries);
      setCwd(library.cwd);
      const next = pickSlug(library.summaries, slug);
      if (next !== slug) {
        // The slug effect above loads the new workflow.
        setSlug(next);
        return;
      }
      if (next) {
        setLoaded(await loadWorkflow(next));
      }
    } catch (cause) {
      errors.report(cause);
    } finally {
      setRefreshing(false);
    }
  }

  return {
    summaries,
    cwd,
    slug,
    selectSlug: setSlug,
    workflow: current?.workflow ?? null,
    runs: current?.runs ?? [],
    putRun,
    refresh,
    refreshing,
  };
}
