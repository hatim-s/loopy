import type { FormEvent } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import type { Json, WorkflowNode } from "../../../packages/loopy/src/model.ts";
import type { AttemptRecord, RunDetail, RunRecord, Workflow, WorkflowSummary } from "./api.ts";
import { captureToken, endpoints } from "./api.ts";
import { BrandMark } from "./brand-mark.tsx";

type Mode = "sandbox" | "full";

function describe(value: unknown): string {
  if (value && typeof value === "object" && "$ref" in value) {
    const ref = value.$ref as { source: string; path: readonly string[] };
    return `${ref.source}.${ref.path.join(".")}`;
  }
  if (value && typeof value === "object" && "$op" in value) {
    const expression = value as { $op: string; args: readonly unknown[] };
    return `${expression.$op}(${expression.args.map(describe).join(", ")})`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatted(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

function latestAttempts(attempts: AttemptRecord[]): Map<string, AttemptRecord> {
  const byNode = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const previous = byNode.get(attempt.nodeId);
    if (
      !previous ||
      attempt.number > previous.number ||
      (attempt.number === previous.number && attempt.startedAt > previous.startedAt)
    ) {
      byNode.set(attempt.nodeId, attempt);
    }
  }
  return byNode;
}

function selectedBranch(attempt?: AttemptRecord): "then" | "else" | undefined {
  if (
    attempt?.status !== "succeeded" ||
    !attempt.output ||
    typeof attempt.output !== "object" ||
    Array.isArray(attempt.output)
  )
    return;
  const branch = attempt.output.branch;
  return branch === "then" || branch === "else" ? branch : undefined;
}

function findNode(nodes: WorkflowNode[], id: string): WorkflowNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "condition") {
      const child = findNode(node.then, id) ?? findNode(node.else, id);
      if (child) return child;
    }
  }
}

function GraphSequence({
  nodes,
  attempts,
  selectedId,
  onSelect,
  inactive = false,
}: {
  nodes: WorkflowNode[];
  attempts: Map<string, AttemptRecord>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  inactive?: boolean;
}) {
  if (nodes.length === 0) return <div className="graph-empty">No steps</div>;

  return (
    <div className={`graph-sequence${inactive ? " graph-sequence-inactive" : ""}`}>
      {nodes.map((node, index) => {
        const attempt = attempts.get(node.id);
        const branch = node.kind === "condition" ? selectedBranch(attempt) : undefined;
        return (
          <div className="graph-step" key={node.id}>
            <button
              type="button"
              className={`graph-node ${node.kind} ${attempt?.status ?? "idle"}${selectedId === node.id ? " selected" : ""}`}
              onClick={() => onSelect(node.id)}
              aria-pressed={selectedId === node.id}
              title={node.id}
            >
              <span className="node-icon" aria-hidden="true">
                {node.kind === "condition" ? "◇" : ">_"}
              </span>
              <span className="node-copy">
                <strong>{node.id}</strong>
                <small>
                  {node.kind === "condition"
                    ? describe(node.test)
                    : `${node.command.program} ${node.command.args.map(describe).join(" ")}`}
                </small>
              </span>
              {attempt && (
                <span className={`node-state ${attempt.status}`} title={attempt.status} />
              )}
            </button>
            {node.kind === "condition" && (
              <div className="branch-layout">
                <div className="branch-rail" aria-hidden="true" />
                <div className="branch-columns">
                  <div
                    className={`branch-arm${branch === "then" ? " taken" : ""}${branch === "else" ? " skipped" : ""}`}
                  >
                    <div className="branch-label">
                      <span>Then</span>
                      {branch === "then" && <span>Taken</span>}
                    </div>
                    <GraphSequence
                      nodes={node.then}
                      attempts={attempts}
                      selectedId={selectedId}
                      onSelect={onSelect}
                      inactive={inactive || branch === "else"}
                    />
                  </div>
                  <div
                    className={`branch-arm${branch === "else" ? " taken" : ""}${branch === "then" ? " skipped" : ""}`}
                  >
                    <div className="branch-label">
                      <span>Else</span>
                      {branch === "else" && <span>Taken</span>}
                    </div>
                    <GraphSequence
                      nodes={node.else}
                      attempts={attempts}
                      selectedId={selectedId}
                      onSelect={onSelect}
                      inactive={inactive || branch === "then"}
                    />
                  </div>
                </div>
                <div className="branch-join">
                  <span>Join</span>
                </div>
              </div>
            )}
            {index < nodes.length - 1 && <div className="graph-link" aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}

function Graph({
  workflow,
  detail,
  selectedId,
  onSelect,
  onSavedDefinition,
}: {
  workflow: Workflow;
  detail: RunDetail | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSavedDefinition: () => void;
}) {
  const attempts = useMemo(() => latestAttempts(detail?.attempts ?? []), [detail]);
  return (
    <section className="graph-pane" aria-label="Workflow graph">
      <div className="pane-heading">
        <div>
          <h2>Workflow graph</h2>
          <p>Select a step to inspect its command and run attempts.</p>
        </div>
        <div className="graph-view">
          <span>{detail ? "Run snapshot" : "Saved definition"}</span>
          {detail && (
            <button type="button" onClick={onSavedDefinition}>
              View saved definition
            </button>
          )}
        </div>
      </div>
      <div className="graph-scroll">
        <div className="graph-canvas">
          <div className="graph-start">Trigger</div>
          <div className="graph-link" aria-hidden="true" />
          <GraphSequence
            nodes={workflow.nodes}
            attempts={attempts}
            selectedId={selectedId}
            onSelect={onSelect}
          />
          <div className="graph-link" aria-hidden="true" />
          <div className="graph-end">End</div>
        </div>
      </div>
    </section>
  );
}

function WorkflowRail({
  summaries,
  selectedSlug,
  onSelect,
  cwd,
  onRefresh,
  refreshing,
}: {
  summaries: WorkflowSummary[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  cwd: string;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}) {
  return (
    <aside className="workflow-rail" aria-label="Saved workflows">
      <div className="rail-head">
        <h2>Saved workflows</h2>
        <div className="rail-actions">
          <span>{summaries.length}</span>
          <button type="button" onClick={() => void onRefresh()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {summaries.length === 0 ? (
        <p className="empty-note">
          No workflows saved. Run <code>loopy save &lt;file.ts&gt;</code> to add one.
        </p>
      ) : (
        <div className="workflow-list">
          {summaries.map((item) => (
            <button
              type="button"
              key={item.slug}
              onClick={() => onSelect(item.slug)}
              className={`workflow-item${selectedSlug === item.slug ? " active" : ""}`}
              aria-current={selectedSlug === item.slug ? "page" : undefined}
            >
              <strong>{item.slug}</strong>
              {item.description && <span>{item.description}</span>}
              <small>
                {item.nodeCount} {item.nodeCount === 1 ? "step" : "steps"} ·{" "}
                {shortDate(item.updatedAt)}
              </small>
            </button>
          ))}
        </div>
      )}
      <div className="rail-foot">
        <span>Working directory</span>
        <code title={cwd}>{cwd || "Loading..."}</code>
      </div>
    </aside>
  );
}

function RunForm({
  slug,
  onRun,
  busy,
}: {
  slug: string;
  onRun: (input: Json, mode: Mode) => Promise<void>;
  busy: boolean;
}) {
  const [input, setInput] = useState("{}");
  const [mode, setMode] = useState<Mode>("sandbox");
  const [inputError, setInputError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let value: Json;
    try {
      value = JSON.parse(input) as Json;
      setInputError(null);
    } catch {
      setInputError("Input must be valid JSON.");
      return;
    }
    await onRun(value, mode);
  }

  return (
    <form className="run-form" onSubmit={submit}>
      <div className="section-heading">
        <h3>Run {slug}</h3>
        <span>Local execution</span>
      </div>
      <label htmlFor={inputId}>Input JSON</label>
      <textarea
        id={inputId}
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setInputError(null);
        }}
        spellCheck={false}
        aria-invalid={!!inputError}
        aria-describedby={inputError ? errorId : undefined}
      />
      {inputError && (
        <p className="field-error" id={errorId}>
          {inputError}
        </p>
      )}
      <fieldset className="mode-choice">
        <legend>Permissions</legend>
        <label className={mode === "sandbox" ? "active" : ""}>
          <input
            type="radio"
            name="mode"
            value="sandbox"
            checked={mode === "sandbox"}
            onChange={() => setMode("sandbox")}
          />
          <span>Sandbox</span>
        </label>
        <label className={mode === "full" ? "active" : ""}>
          <input
            type="radio"
            name="mode"
            value="full"
            checked={mode === "full"}
            onChange={() => setMode("full")}
          />
          <span>Full access</span>
        </label>
      </fieldset>
      <p className="permission-help">
        {mode === "sandbox"
          ? "Workspace writes are allowed. Network access is blocked."
          : "Run with your local user permissions."}
      </p>
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? "Starting..." : "Run workflow"}
      </button>
    </form>
  );
}

function NodeInspector({
  node,
  detail,
}: {
  node: WorkflowNode | undefined;
  detail: RunDetail | null;
}) {
  if (!node)
    return (
      <section className="inspector-section">
        <div className="section-heading">
          <h3>Step</h3>
        </div>
        <p className="empty-note">Select a step in the graph to see its definition.</p>
      </section>
    );
  const attempts = detail?.attempts.filter((attempt) => attempt.nodeId === node.id) ?? [];
  return (
    <section className="inspector-section">
      <div className="section-heading">
        <h3>{node.id}</h3>
        <span>{node.kind}</span>
      </div>
      {node.kind === "command" ? (
        <div className="definition">
          <div>
            <span>Program</span>
            <code>{node.command.program}</code>
          </div>
          <div>
            <span>Arguments</span>
            <pre>
              {node.command.args.length ? node.command.args.map(describe).join(" ") : "None"}
            </pre>
          </div>
          {node.command.cwd && (
            <div>
              <span>Directory</span>
              <code>{node.command.cwd}</code>
            </div>
          )}
          {node.command.stdin !== undefined && (
            <div>
              <span>Standard input</span>
              <pre>{describe(node.command.stdin)}</pre>
            </div>
          )}
          {node.command.env && (
            <div>
              <span>Environment</span>
              <pre>{formatted(node.command.env)}</pre>
            </div>
          )}
          {node.command.timeoutMs && (
            <div>
              <span>Timeout</span>
              <code>{node.command.timeoutMs} ms</code>
            </div>
          )}
        </div>
      ) : (
        <div className="definition">
          <div>
            <span>Condition</span>
            <pre>{describe(node.test)}</pre>
          </div>
          <div>
            <span>Then</span>
            <code>{node.then.length} steps</code>
          </div>
          <div>
            <span>Else</span>
            <code>{node.else.length} steps</code>
          </div>
        </div>
      )}
      {detail && (
        <div className="node-attempts">
          <h4>Attempts in this run</h4>
          {attempts.length === 0 ? (
            <p className="empty-note">This step has not run.</p>
          ) : (
            attempts.map((attempt) => <Attempt key={attempt.id} attempt={attempt} />)
          )}
        </div>
      )}
    </section>
  );
}

function outputText(output: Json | undefined, key: "stdout" | "stderr"): string | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return;
  const value = output[key];
  return typeof value === "string" ? value : undefined;
}

function Attempt({ attempt }: { attempt: AttemptRecord }) {
  const stdout = outputText(attempt.output, "stdout");
  const stderr = outputText(attempt.output, "stderr");
  const branch = selectedBranch(attempt);
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
      {!stdout && !stderr && attempt.output !== undefined && !branch && (
        <div className="stream">
          <span>Output</span>
          <pre>{formatted(attempt.output)}</pre>
        </div>
      )}
    </div>
  );
}

function RunPanel({
  runs,
  selectedRunId,
  onSelect,
  detail,
  onResume,
  busy,
}: {
  runs: RunRecord[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  detail: RunDetail | null;
  onResume: (retryUncertain: boolean) => Promise<void>;
  busy: boolean;
}) {
  const [retryUncertain, setRetryUncertain] = useState(false);
  const selected = detail?.run;
  const uncertainCount =
    detail?.attempts.filter((attempt) => attempt.status === "uncertain").length ?? 0;
  return (
    <section className="runs-section">
      <div className="section-heading">
        <h3>Runs</h3>
        <span>{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="empty-note">No runs yet. Enter JSON and run this workflow.</p>
      ) : (
        <div className="run-list">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`run-item${selectedRunId === run.id ? " active" : ""}`}
              onClick={() => onSelect(run.id)}
              aria-pressed={selectedRunId === run.id}
            >
              <span className={`status ${run.status}`}>{run.status}</span>
              <span className="run-id">{shortId(run.id)}</span>
              <time>{shortDate(run.createdAt)}</time>
            </button>
          ))}
        </div>
      )}
      {selectedRunId && !detail && <p className="empty-note">Loading run...</p>}
      {selected && (
        <div className="run-detail">
          <div className="run-detail-head">
            <div>
              <strong>{selected.status}</strong>
              <code title={selected.id}>{selected.id}</code>
            </div>
            <span>{selected.options.mode}</span>
          </div>
          {selected.error && <pre className="error-output">{selected.error}</pre>}
          <dl className="run-meta">
            <div>
              <dt>Started</dt>
              <dd>{shortDate(selected.createdAt)}</dd>
            </div>
            <div>
              <dt>Directory</dt>
              <dd title={selected.options.cwd}>{selected.options.cwd}</dd>
            </div>
          </dl>
          {(selected.status === "failed" || selected.status === "interrupted") && (
            <div className="resume-controls">
              {uncertainCount > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={retryUncertain}
                    onChange={(event) => setRetryUncertain(event.target.checked)}
                  />
                  Retry {uncertainCount} uncertain {uncertainCount === 1 ? "step" : "steps"}
                </label>
              )}
              {uncertainCount > 0 && (
                <p>
                  These steps may have finished before Loopy stopped. Retrying can repeat their side
                  effects.
                </p>
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
          )}
          <details className="run-input">
            <summary>Run input</summary>
            <pre>{formatted(selected.input)}</pre>
          </details>
          <div className="detail-list">
            <h4>Attempts</h4>
            {detail.attempts.length === 0 ? (
              <p className="empty-note">Waiting for the first step.</p>
            ) : (
              detail.attempts.map((attempt) => (
                <details key={attempt.id} className="attempt-fold">
                  <summary>
                    <span>
                      {attempt.nodeId} <small>#{attempt.number}</small>
                    </span>
                    <span className={`status ${attempt.status}`}>{attempt.status}</span>
                  </summary>
                  <Attempt attempt={attempt} />
                </details>
              ))
            )}
          </div>
          <div className="detail-list">
            <h4>Events</h4>
            {detail.events.length === 0 ? (
              <p className="empty-note">No events yet.</p>
            ) : (
              <ol className="event-list">
                {detail.events.map((event) => (
                  <li key={event.sequence}>
                    <span className="event-time">{shortDate(event.createdAt)}</span>
                    <strong>{event.type}</strong>
                    {event.nodeId && <code>{event.nodeId}</code>}
                    <details>
                      <summary>Data</summary>
                      <pre>{formatted(event.data)}</pre>
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

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
  const [busy, setBusy] = useState<"run" | "resume" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        const sorted = [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRuns(sorted);
        setSelectedRunId(sorted[0]?.id ?? null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

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
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (
      !slug ||
      !selectedRunId ||
      (detail?.run.status !== "pending" &&
        detail?.run.status !== "running" &&
        resumeBaseline?.id !== selectedRunId)
    )
      return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void Promise.all([endpoints.runs(slug), endpoints.run(selectedRunId)])
        .then(([history, next]) => {
          if (cancelled) return;
          setRuns([...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
          setDetail(next);
          if (
            resumeBaseline?.id === selectedRunId &&
            next.run.updatedAt !== resumeBaseline.updatedAt
          )
            setResumeBaseline(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [slug, selectedRunId, detail?.run.status, resumeBaseline]);

  async function start(input: Json, mode: Mode) {
    if (!slug) return;
    setBusy("run");
    setError(null);
    try {
      const run = await endpoints.start(slug, input, mode);
      setRuns((previous) => [run, ...previous.filter((item) => item.id !== run.id)]);
      setSelectedRunId(run.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
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
        setRuns([...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      } else {
        setWorkflow(null);
        setRuns([]);
        setSelectedRunId(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    setBusy("resume");
    setError(null);
    try {
      const run = await endpoints.resume(selectedRunId, retryUncertain);
      setRuns((previous) => previous.map((item) => (item.id === run.id ? run : item)));
      setDetail((previous) => (previous ? { ...previous, run } : previous));
      if (baseline) setResumeBaseline({ id: run.id, updatedAt: baseline });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
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
          Local workflows <span aria-hidden="true">/</span> {slug ?? "No workflow"}
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
              <RunForm
                key={workflow.slug}
                slug={workflow.slug}
                onRun={start}
                busy={busy !== null}
              />
              <RunPanel
                key={selectedRunId}
                runs={runs}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
                detail={detail}
                onResume={resume}
                busy={busy !== null}
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
