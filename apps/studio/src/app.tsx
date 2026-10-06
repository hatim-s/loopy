import type { Json } from "loopy";
import { useCallback, useEffect, useState } from "react";
import type { Mode, RunDetail, RunRecord, Workflow, WorkflowSummary } from "./api.ts";
import { captureToken, endpoints } from "./api.ts";
import { BrandMark } from "./brand-mark.tsx";
import { errorText, findNode } from "./format.ts";
import { Graph } from "./graph.tsx";
import { NodeInspector } from "./inspector.tsx";
import { WorkflowRail } from "./rail.tsx";
import { RunForm } from "./run-form.tsx";
import { RunPanel } from "./runs.tsx";

const POLL_MS = 1000;

const newestFirst = (runs: RunRecord[]) =>
  [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function App() {
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [cwd, setCwd] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((cause: unknown) => setError(errorText(cause)), []);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // After a resume request, keep polling until the server reports a newer updatedAt.
  const [resumeBaseline, setResumeBaseline] = useState<{ id: string; updatedAt: string } | null>(
    null,
  );

  useEffect(() => {
    captureToken();
    let cancelled = false;
    void Promise.all([endpoints.workflows(), endpoints.config()])
      .then(([items, config]) => {
        if (cancelled) return;
        setSummaries(items);
        setCwd(config.cwd);
        const requested = new URLSearchParams(window.location.search).get("workflow");
        setSlug(items.find((item) => item.slug === requested)?.slug ?? items[0]?.slug ?? null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) fail(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [fail]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setWorkflow(null);
    setRuns([]);
    setDetail(null);
    setSelectedRunId(null);
    setSelectedNodeId(null);
    setResumeBaseline(null);
    const url = new URL(window.location.href);
    url.searchParams.set("workflow", slug);
    history.replaceState(null, "", url);
    void Promise.all([endpoints.workflow(slug), endpoints.runs(slug)])
      .then(([definition, history]) => {
        if (cancelled) return;
        setWorkflow(definition);
        const sorted = newestFirst(history);
        setRuns(sorted);
        setSelectedRunId(sorted[0]?.id ?? null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) fail(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, fail]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    void endpoints
      .run(selectedRunId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) fail(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, fail]);

  useEffect(() => {
    const active = detail?.run.status === "pending" || detail?.run.status === "running";
    const awaitingResume = resumeBaseline?.id === selectedRunId;
    if (!slug || !selectedRunId || (!active && !awaitingResume)) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void endpoints
        .run(selectedRunId)
        .then((next) => {
          if (cancelled) return;
          setRuns((previous) => previous.map((run) => (run.id === next.run.id ? next.run : run)));
          setDetail(next);
          if (awaitingResume && next.run.updatedAt !== resumeBaseline?.updatedAt)
            setResumeBaseline(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) fail(cause);
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [slug, selectedRunId, detail?.run.status, resumeBaseline, fail]);

  async function start(input: Json, mode: Mode) {
    if (!slug) return;
    setBusy(true);
    setError(null);
    try {
      const run = await endpoints.start(slug, input, mode);
      setRuns((previous) => [run, ...previous.filter((item) => item.id !== run.id)]);
      setSelectedRunId(run.id);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function refreshSaved() {
    setRefreshing(true);
    setError(null);
    try {
      const [items, config] = await Promise.all([endpoints.workflows(), endpoints.config()]);
      setSummaries(items);
      setCwd(config.cwd);
      const nextSlug = items.find((item) => item.slug === slug)?.slug ?? items[0]?.slug ?? null;
      if (nextSlug !== slug) {
        setSlug(nextSlug);
      } else if (nextSlug) {
        const [definition, history] = await Promise.all([
          endpoints.workflow(nextSlug),
          endpoints.runs(nextSlug),
        ]);
        setWorkflow(definition);
        setRuns(newestFirst(history));
      } else {
        setWorkflow(null);
        setRuns([]);
        setSelectedRunId(null);
      }
    } catch (cause) {
      fail(cause);
    } finally {
      setRefreshing(false);
    }
  }

  function viewSavedDefinition() {
    setSelectedRunId(null);
    setDetail(null);
    setSelectedNodeId(null);
    setResumeBaseline(null);
  }

  async function resume(retryUncertain: boolean) {
    if (!selectedRunId) return;
    const baseline = detail?.run.updatedAt;
    setBusy(true);
    setError(null);
    try {
      const run = await endpoints.resume(selectedRunId, retryUncertain);
      setRuns((previous) => previous.map((item) => (item.id === run.id ? run : item)));
      setDetail((previous) => (previous ? { ...previous, run } : previous));
      if (baseline) setResumeBaseline({ id: run.id, updatedAt: baseline });
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  const viewedWorkflow = selectedRunId ? detail?.run.workflow : workflow;
  const node =
    viewedWorkflow && selectedNodeId ? findNode(viewedWorkflow.nodes, selectedNodeId) : undefined;

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
          Review workflows <span aria-hidden="true">/</span> {slug ?? "No workflow"}
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      <div className="workspace">
        <WorkflowRail
          summaries={summaries}
          selectedSlug={slug}
          onSelect={setSlug}
          cwd={cwd}
          onRefresh={refreshSaved}
          refreshing={refreshing}
        />
        {workflow ? (
          <>
            {viewedWorkflow ? (
              <Graph
                workflow={viewedWorkflow}
                detail={detail}
                selectedId={selectedNodeId}
                onSelect={setSelectedNodeId}
                onSavedDefinition={viewSavedDefinition}
              />
            ) : (
              <div className="graph-pane graph-loading">Loading run snapshot...</div>
            )}
            <aside className="inspector" aria-label="Workflow details">
              <NodeInspector node={node} detail={detail} />
              <RunForm key={workflow.slug} slug={workflow.slug} onRun={start} busy={busy} />
              <RunPanel
                key={selectedRunId}
                runs={runs}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
                detail={detail}
                onResume={resume}
                busy={busy}
              />
            </aside>
          </>
        ) : (
          <main className="main-empty">
            <h1>{slug ? "Loading workflow..." : "No workflow selected"}</h1>
            <p>
              {slug
                ? "Reading its definition and run history."
                : "Create or update workflows with the CLI or API, then review them here."}
            </p>
          </main>
        )}
      </div>
    </div>
  );
}
