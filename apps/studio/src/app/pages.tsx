import { ArrowUpRight, GitBranch, HardDrives, Plus, ShieldCheck } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../components/primitives/states";
import {
  AttemptDetails,
  DebuggerGraph,
  EventTimeline,
  ExtractionReview,
  ImportedSessionList,
  ProviderCapabilityList,
  RunControls,
} from "../features";
import { ApprovalControls } from "../features/builder/approval-controls";
import { ToolLibrary } from "../features/builder/tool-library";
import type { GraphInputEdge, GraphInputNode } from "../features/debugger";
import { createDebuggerState, debuggerReducer, replayEvents } from "../features/debugger";
import { fallbackWorkflow } from "../features/editor";
import type { ReviewChanges } from "../features/extraction-edits";
import { ProviderReadiness } from "../features/provider-readiness";
import type {
  DebuggerEvent,
  DebuggerSnapshot,
  ExtractionReviewModel,
  ImportedSession,
  ProviderCapability,
} from "../features/types";
import type { ApiClient } from "./api";

export type StudioPageProps = { feature: string; api?: ApiClient };

function useResource<T>(api: ApiClient | undefined, path: string | undefined) {
  const [state, setState] = useState<{
    value?: T;
    error?: string;
    loading: boolean;
    path?: string;
  }>({
    path,
    loading: Boolean(api && path),
  });
  useEffect(() => {
    if (!api || !path) {
      setState({ path, loading: false });
      return;
    }
    let active = true;
    setState({ path, loading: true });
    void api
      .request<T>(path)
      .then((value) => active && setState({ path, value, loading: false }))
      .catch((error: unknown) => {
        if (active)
          setState({
            path,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
    };
  }, [api, path]);
  return state.path === path ? state : { loading: Boolean(api && path) };
}

function PageFrame({
  title,
  eyebrow,
  children,
  action,
}: {
  title: string;
  eyebrow: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const titleId = `feature-page-title-${useId().replaceAll(":", "")}`;
  return (
    <section className="feature-page" aria-labelledby={titleId}>
      <div className="feature-page__heading">
        <div>
          <h1 id={titleId}>{title}</h1>
          <p>
            {
              (
                {
                  "Build / graphs": "Build, save, and run graphs in this project.",
                  "Inspect / sessions": "Bring completed agent work into your workspace.",
                  "Inspect / runs": "Follow each decision, inspect every result.",
                  "Inspect / extractions":
                    "Review what was recovered from a recorded session before publishing.",
                  "Build / providers": "The agents and command-line tools behind your workflows.",
                  "System / settings": "A private workspace, running on your computer.",
                } as Record<string, string>
              )[eyebrow]
            }
          </p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ProvidersPage({ api }: StudioPageProps) {
  const result = useResource<{ capabilities?: ProviderCapability[] }>(
    api,
    "/providers/capabilities",
  );
  const capabilities = result.value?.capabilities ?? [];
  return (
    <PageFrame title="Tools and providers" eyebrow="Build / providers">
      {api ? <ProviderReadiness api={api} /> : null}
      {api ? <ToolLibrary api={api} /> : null}
      {result.loading ? <LoadingState label="Loading provider connections" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error ? (
        <ProviderCapabilityList
          capabilities={capabilities}
          status={capabilities.length ? undefined : "empty"}
        />
      ) : null}
    </PageFrame>
  );
}

export function SessionsPage({ api }: StudioPageProps) {
  const [revision, setRevision] = useState(0);
  const result = useResource<{ sessions?: ImportedSession[] }>(
    api,
    `/sessions?revision=${revision}`,
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [provider, setProvider] = useState("codex");
  const [file, setFile] = useState<File>();
  const [pending, setPending] = useState<"import" | "extract">();
  const [error, setError] = useState<string>();
  const fileId = useId();
  const providerId = useId();
  const navigate = useNavigate();
  const importTrace = async () => {
    if (!api || !file) return;
    setPending("import");
    setError(undefined);
    try {
      const raw = await file.text();
      const content = raw.trimStart().startsWith("[")
        ? `${(JSON.parse(raw) as unknown[]).map((event) => JSON.stringify(event)).join("\n")}\n`
        : raw;
      const session = await api.request<ImportedSession>("/sessions", {
        method: "POST",
        body: JSON.stringify({ provider, source: file.name, content }),
      });
      setSelectedId(session.id);
      setFile(undefined);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  };
  const extract = async () => {
    if (!api || !selectedId) return;
    setPending("extract");
    setError(undefined);
    try {
      await api.request("/extractions", {
        method: "POST",
        body: JSON.stringify({ importId: selectedId }),
      });
      await navigate({ to: "/extractions" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <PageFrame title="Agent sessions" eyebrow="Inspect / sessions">
      <p className="feature-page__lede">
        Import a canonical Loopy trace, then extract a workflow proposal to review and edit in the
        builder.
      </p>
      <form
        className="feature-page__actions"
        onSubmit={(event) => {
          event.preventDefault();
          void importTrace();
        }}
      >
        <label htmlFor={providerId}>Provider</label>
        <select
          id={providerId}
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          disabled={Boolean(pending)}
        >
          {["codex", "claude", "opencode", "pi"].map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <label htmlFor={fileId}>Canonical trace file</label>
        <input
          key={revision}
          id={fileId}
          type="file"
          accept=".jsonl,.json"
          disabled={Boolean(pending)}
          onChange={(event) => setFile(event.target.files?.[0])}
        />
        <button type="submit" disabled={!api || !file || Boolean(pending)}>
          {pending === "import" ? "Importing trace…" : "Import trace"}
        </button>
        <button
          type="button"
          disabled={!api || !selectedId || Boolean(pending)}
          onClick={() => void extract()}
        >
          {pending === "extract" ? "Extracting session…" : "Extract selected session"}
        </button>
      </form>
      {error ? <ErrorState message={error} /> : null}
      {result.loading ? <LoadingState label="Loading imported sessions" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error ? (
        <ImportedSessionList
          sessions={result.value?.sessions ?? []}
          selectedId={selectedId}
          onSelect={(session) => setSelectedId(session.id)}
          status={result.value?.sessions?.length ? undefined : "empty"}
        />
      ) : null}
    </PageFrame>
  );
}

const extractionReference = (review: ExtractionReviewModel) =>
  review.jobId ?? review.proposalId ?? review.importId;

export function ExtractionsPage({ api }: StudioPageProps) {
  const [revision, setRevision] = useState(0);
  const result = useResource<{ reviews?: ExtractionReviewModel[]; jobs?: unknown[] }>(
    api,
    `/extractions?revision=${revision}`,
  );
  const [pendingAction, setPendingAction] = useState<"approve" | "reject" | "review">();
  const [published, setPublished] = useState<{ workflowId: string; version: number }>();
  const [decision, setDecision] = useState<"approved" | "rejected">();
  const [actionError, setActionError] = useState<string>();
  const [selectedReview, setSelectedReview] = useState<string>();
  const reviewSelectId = useId();
  const reviews = (result.value?.reviews ?? []).map(normalizeExtractionReview).reverse();
  const rawReview =
    reviews.find((item) => extractionReference(item) === selectedReview) ?? reviews[0];
  const review = rawReview;
  const publishedGraph = published ?? review?.publishedWorkflow;
  const submitDecision = async (action: "approve" | "reject") => {
    if (!api || !review) return;
    setPendingAction(action);
    setActionError(undefined);
    try {
      const response = await api.request<{ workflowId: string; version: number }>(
        `/extractions/${encodeURIComponent(extractionReference(review))}/${action}`,
        {
          method: "POST",
          body: JSON.stringify(
            action === "reject"
              ? { reason: "Rejected in Studio" }
              : { expectedProposalHash: review.proposalHash },
          ),
        },
      );
      if (action === "approve") setPublished(response);
      setDecision(action === "approve" ? "approved" : "rejected");
      setRevision((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(undefined);
    }
  };
  const saveReview = async (changes: ReviewChanges) => {
    if (!api || !review) return;
    setPendingAction("review");
    setActionError(undefined);
    try {
      await api.request(`/extractions/${encodeURIComponent(extractionReference(review))}/review`, {
        method: "POST",
        body: JSON.stringify({ ...changes, expectedProposalHash: review.proposalHash }),
      });
      setRevision((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(undefined);
    }
  };
  return (
    <PageFrame title="Trace extractions" eyebrow="Inspect / extractions">
      {reviews.length ? (
        <label htmlFor={reviewSelectId}>
          Proposal{" "}
          <select
            id={reviewSelectId}
            value={review ? extractionReference(review) : ""}
            onChange={(event) => {
              setSelectedReview(event.target.value);
              setDecision(undefined);
              setPublished(undefined);
              setActionError(undefined);
            }}
            disabled={Boolean(pendingAction)}
          >
            {reviews.map((item) => (
              <option key={extractionReference(item)} value={extractionReference(item)}>
                {extractionReference(item)} · {item.status}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {decision === "approved" || review?.status === "approved" ? (
        publishedGraph ? (
          <Link to="/workflows/$workflowId/edit" params={{ workflowId: publishedGraph.workflowId }}>
            Open published graph, version {publishedGraph.version}
          </Link>
        ) : (
          <Link to="/workflows">Open published graphs</Link>
        )
      ) : null}
      {result.loading ? <LoadingState label="Loading extraction reviews" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {actionError ? (
        <ErrorState message={`Unable to ${pendingAction ?? "update"} extraction: ${actionError}`} />
      ) : null}
      {!result.loading && !result.error && review ? (
        <ExtractionReview
          key={`${extractionReference(review)}:${review.proposalHash ?? revision}`}
          onSaveReview={saveReview}
          model={decision ? { ...review, status: decision } : review}
          actionsDisabled={Boolean(pendingAction || decision)}
          onApprove={() => void submitDecision("approve")}
          onReject={() => void submitDecision("reject")}
        />
      ) : null}
      {!result.loading && !result.error && !review ? (
        <EmptyState
          title="No extraction proposals"
          detail="Import a session to generate a reviewable workflow proposal."
        />
      ) : null}
    </PageFrame>
  );
}

export function normalizeExtractionReview(value: unknown): ExtractionReviewModel {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const proposal = (source.proposal ?? {}) as ExtractionReviewModel["proposal"];
  const job =
    source.job && typeof source.job === "object" ? (source.job as Record<string, unknown>) : {};
  const imported =
    source.import && typeof source.import === "object"
      ? (source.import as Record<string, unknown>)
      : {};
  const rawProposal =
    proposal && typeof proposal === "object" ? (proposal as Record<string, unknown>) : {};
  const nodeEvidence = Array.isArray(rawProposal.nodeEvidence) ? rawProposal.nodeEvidence : [];
  const evidence = nodeEvidence.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.evidenceId !== "string" || !Array.isArray(record.eventIds)) return [];
    return [
      {
        evidenceId: record.evidenceId,
        eventIds: record.eventIds.filter((id): id is string => typeof id === "string"),
        rationale: typeof record.rationale === "string" ? record.rationale : undefined,
        label: typeof record.nodeId === "string" ? `Node ${record.nodeId}` : undefined,
      },
    ];
  });
  const warnings = Array.isArray(rawProposal.warnings)
    ? rawProposal.warnings.map((warning) =>
        typeof warning === "string"
          ? warning
          : warning &&
              typeof warning === "object" &&
              typeof (warning as { message?: unknown }).message === "string"
            ? (warning as { message: string }).message
            : String(warning),
      )
    : [];
  const hasBlockingQuestion =
    Array.isArray(rawProposal.unresolvedQuestions) &&
    rawProposal.unresolvedQuestions.some(
      (question) =>
        question &&
        typeof question === "object" &&
        (question as { blocksExecution?: unknown }).blocksExecution === true,
    );
  const status =
    rawProposal.status === "approved" || rawProposal.status === "rejected"
      ? rawProposal.status
      : hasBlockingQuestion
        ? "blocked"
        : "draft";
  const audit =
    source.audit && typeof source.audit === "object"
      ? (source.audit as {
          publishedWorkflow?: ExtractionReviewModel["publishedWorkflow"];
          reviewHistory?: { resolutions?: ExtractionReviewModel["resolutions"] }[];
        })
      : {};
  return {
    publishedWorkflow: audit.publishedWorkflow,
    resolutions: audit.reviewHistory?.flatMap((entry) => entry.resolutions ?? []),
    proposalHash: typeof source.proposalHash === "string" ? source.proposalHash : undefined,
    jobId: typeof job.id === "string" ? job.id : undefined,
    importId:
      typeof job.importId === "string"
        ? job.importId
        : typeof rawProposal.importId === "string"
          ? rawProposal.importId
          : "unknown-import",
    proposalId:
      typeof rawProposal.id === "string"
        ? rawProposal.id
        : typeof job.id === "string"
          ? job.id
          : undefined,
    sourceLabel:
      [imported.provider, imported.source]
        .filter((part): part is string => typeof part === "string")
        .join(" · ") || "Imported session",
    sourceEvents: Array.isArray(imported.session)
      ? (imported.session as ExtractionReviewModel["sourceEvents"])
      : [],
    proposal,
    evidence,
    lossiness:
      imported.lossiness && typeof imported.lossiness === "object"
        ? (imported.lossiness as ExtractionReviewModel["lossiness"])
        : undefined,
    status,
    warnings,
  };
}

export function WorkflowsPage({ api }: StudioPageProps) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const create = async () => {
    if (!api) return;
    setCreating(true);
    try {
      const definition = fallbackWorkflow(crypto.randomUUID());
      await api.request("/workflows", { method: "POST", body: JSON.stringify({ definition }) });
      await navigate({ to: "/workflows/$workflowId/edit", params: { workflowId: definition.id } });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };
  const result = useResource<{
    workflows?: Array<{ workflowId?: string; version?: number; definition?: unknown }>;
  }>(api, "/workflows");
  // Editing always opens the current version, so the library represents each graph once.
  const latest = new Map<
    string,
    NonNullable<NonNullable<typeof result.value>["workflows"]>[number]
  >();
  for (const workflow of result.value?.workflows ?? []) {
    if (!workflow.workflowId) continue;
    const previous = latest.get(workflow.workflowId);
    if (!previous || (workflow.version ?? 0) > (previous.version ?? 0))
      latest.set(workflow.workflowId, workflow);
  }
  const workflows = [...latest.values()];
  return (
    <PageFrame
      title="Graph library"
      eyebrow="Build / graphs"
      action={
        <button
          type="button"
          className="editor-primary-button"
          disabled={!api || creating}
          onClick={() => void create()}
        >
          <Plus size={16} />
          {creating ? "Creating…" : "New graph"}
        </button>
      }
    >
      {createError ? <ErrorState message={createError} /> : null}
      {result.loading ? <LoadingState label="Loading workflows" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error && !workflows.length ? (
        <EmptyState
          title="Your first graph starts here"
          detail="Create a graph and connect an agent, a condition, or a shell module. You can also import a completed session."
        />
      ) : null}
      {workflows.length ? (
        <>
          <div className="library-summary">
            {workflows.length} graph{workflows.length === 1 ? "" : "s"} in this project
          </div>
          <ul className="graph-library data-list" aria-label="Execution graph versions">
            {workflows.map((workflow) => {
              const definition =
                workflow.definition && typeof workflow.definition === "object"
                  ? (workflow.definition as {
                      name?: string;
                      description?: string;
                      nodes?: unknown[];
                    })
                  : undefined;
              return (
                <li className="graph-card" key={workflow.workflowId}>
                  <Link
                    to="/workflows/$workflowId/edit"
                    params={{ workflowId: workflow.workflowId ?? "" }}
                    className="graph-card-link"
                  >
                    <div className="graph-card-top">
                      <GitBranch aria-hidden="true" />
                      <span className="graph-version">Version {workflow.version ?? 1}</span>
                    </div>
                    <h2>{definition?.name ?? "Unnamed graph"}</h2>
                    <p>
                      {definition?.description || "Connect steps into a repeatable local workflow."}
                    </p>
                    <div className="graph-card-footer">
                      <span>
                        {definition?.nodes?.length ?? 0} step
                        {definition?.nodes?.length === 1 ? "" : "s"}
                      </span>
                      <strong>
                        Open graph <ArrowUpRight size={14} aria-hidden="true" />
                      </strong>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </PageFrame>
  );
}

export type WorkflowTopology = { nodes: GraphInputNode[]; edges: GraphInputEdge[] };

export function topologyFrom(value: unknown): WorkflowTopology | undefined {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const candidates = [source, source.topology, source.plan, source.definition, source.workflow];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const graph = candidate as Record<string, unknown>;
    const nodes = Array.isArray(graph.nodes)
      ? graph.nodes.flatMap((node) => {
          if (!node || typeof node !== "object") return [];
          const item = node as Record<string, unknown>;
          if (typeof item.id !== "string" && typeof item.nodeId !== "string") return [];
          return [
            {
              id: String(item.id ?? item.nodeId),
              ...(typeof item.name === "string" ? { name: item.name } : {}),
              ...(typeof item.label === "string" ? { label: item.label } : {}),
              ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
            },
          ];
        })
      : [];
    const edges = Array.isArray(graph.edges)
      ? graph.edges.flatMap((edge) => {
          if (!edge || typeof edge !== "object") return [];
          const item = edge as Record<string, unknown>;
          if (typeof item.source !== "string" || typeof item.target !== "string") return [];
          return [
            {
              ...(typeof item.id === "string" ? { id: item.id } : {}),
              source: item.source,
              target: item.target,
              ...(typeof item.label === "string" ? { label: item.label } : {}),
              ...(typeof item.branch === "string" ? { branch: item.branch } : {}),
            },
          ];
        })
      : [];
    if (nodes.length) return { nodes, edges };
  }
  return undefined;
}

function normalizeStudioStatus(value: unknown): DebuggerSnapshot["status"] {
  if (value === "paused") return "paused";
  if (value === "failed") return "failed";
  if (value === "completed" || value === "succeeded" || value === "cancelled") return "completed";
  if (
    value === "running" ||
    value === "created" ||
    value === "pause_requested" ||
    value === "cancelling"
  )
    return "live";
  return "loading";
}

export function snapshotFrom(
  value: unknown,
  runId: string,
): DebuggerSnapshot & { topology?: WorkflowTopology } {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const run =
    source.run && typeof source.run === "object" ? (source.run as Record<string, unknown>) : source;
  const plan = run.plan && typeof run.plan === "object" ? run.plan : undefined;
  const topology = topologyFrom(plan) ?? topologyFrom(source);
  const events = Array.isArray(source.events) ? (source.events as DebuggerEvent[]) : [];
  return {
    runId,
    workflowId:
      typeof source.workflowId === "string"
        ? source.workflowId
        : typeof run.workflowId === "string"
          ? run.workflowId
          : undefined,
    workflowVersion:
      typeof source.workflowVersion === "number"
        ? source.workflowVersion
        : typeof run.workflowVersion === "number"
          ? run.workflowVersion
          : undefined,
    status: normalizeStudioStatus(source.status ?? run.status),
    events,
    attempts: Array.isArray(source.attempts) ? source.attempts : undefined,
    artifacts: Array.isArray(source.artifacts) ? source.artifacts : undefined,
    ...(topology ? { topology } : {}),
  };
}

function RunDebugger({
  api,
  runId,
  onStatus,
}: {
  api?: ApiClient;
  runId: string;
  onStatus: (runId: string, status: string) => void;
}) {
  const result = useResource<unknown>(api, `/runs/${encodeURIComponent(runId)}`);
  const baseSnapshot = useMemo(
    () => (result.value ? snapshotFrom(result.value, runId) : undefined),
    [result.value, runId],
  );
  const eventsFallback = useResource<{ events?: DebuggerEvent[] }>(
    api,
    baseSnapshot && !baseSnapshot.events.length
      ? `/runs/${encodeURIComponent(runId)}/events`
      : undefined,
  );
  const attemptsFallback = useResource<{ attempts?: DebuggerSnapshot["attempts"] }>(
    api,
    baseSnapshot && !baseSnapshot.attempts?.length
      ? `/runs/${encodeURIComponent(runId)}/attempts`
      : undefined,
  );
  const artifactsFallback = useResource<{ artifacts?: DebuggerSnapshot["artifacts"] }>(
    api,
    baseSnapshot && !baseSnapshot.artifacts?.length
      ? `/runs/${encodeURIComponent(runId)}/artifacts`
      : undefined,
  );
  const snapshot = useMemo(
    () =>
      result.value
        ? snapshotFrom(
            {
              ...(result.value as Record<string, unknown>),
              ...(eventsFallback.value?.events ? { events: eventsFallback.value.events } : {}),
              ...(attemptsFallback.value?.attempts
                ? { attempts: attemptsFallback.value.attempts }
                : {}),
              ...(artifactsFallback.value?.artifacts
                ? { artifacts: artifactsFallback.value.artifacts }
                : {}),
            },
            runId,
          )
        : undefined,
    [result.value, eventsFallback.value, attemptsFallback.value, artifactsFallback.value, runId],
  );
  const workflowResult = useResource<unknown>(
    api,
    snapshot?.workflowId && !snapshot.topology
      ? `/workflows/${encodeURIComponent(snapshot.workflowId)}/${snapshot.workflowVersion ?? 1}`
      : undefined,
  );
  const [state, dispatch] = useState(() => createDebuggerState(runId));
  const [message, setMessage] = useState<string>();
  const [connection, setConnection] = useState("connecting");
  const [streamRevision, setStreamRevision] = useState(0);
  const runStatus =
    state.status === "live"
      ? "running"
      : state.status === "completed"
        ? String(
            [...state.events].reverse().find((event) => event.type === "run.completed")?.payload
              ?.status ?? "completed",
          )
        : state.status;
  useEffect(() => {
    if (runStatus !== "loading" && runStatus !== "error") onStatus(runId, runStatus);
  }, [onStatus, runId, runStatus]);
  useEffect(() => {
    if (!snapshot) return;
    dispatch(debuggerReducer(createDebuggerState(runId), { type: "snapshot", snapshot }));
  }, [runId, snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect restarts the authenticated stream from its snapshot cursor.
  useEffect(() => {
    if (!api || result.error) return;
    setConnection("connecting");
    setMessage(undefined);
    let pending: DebuggerEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = api.streamEvents(
      runId,
      (event) => {
        pending.push(event as DebuggerEvent);
        timer ??= setTimeout(() => {
          const events = pending;
          pending = [];
          timer = undefined;
          dispatch((current) => debuggerReducer(current, { type: "events", events }));
        }, 16);
      },
      {
        afterSequence: snapshot?.events.reduce(
          (max, event) => Math.max(max, event.sequence ?? max),
          -1,
        ),
        onError: (error) => setMessage(error.message),
        onConnectionChange: setConnection,
      },
    );
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [api, result.error, runId, snapshot?.events, streamRevision]);
  const dispatchEvent = (event: DebuggerEvent) =>
    dispatch((current) => debuggerReducer(current, { type: "event", event }));
  const command = async (descriptor: { endpoint: string; method: string; body?: unknown }) => {
    if (!api) return;
    try {
      const result = await api.request<{ id?: string }>(descriptor.endpoint, {
        method: descriptor.method,
        body: JSON.stringify(descriptor.body ?? {}),
      });
      if (descriptor.endpoint.endsWith("/fork") && result.id)
        window.location.assign(`/runs?runId=${encodeURIComponent(result.id)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="debugger-page">
      <output className="debugger-run-status">
        Run status: <strong>{runStatus}</strong>
        {state.status === "live" || state.status === "paused" ? (
          <span>Live updates: {connection}</span>
        ) : null}
        {connection === "disconnected" && (state.status === "live" || state.status === "paused") ? (
          <button type="button" onClick={() => setStreamRevision((value) => value + 1)}>
            Reconnect updates
          </button>
        ) : null}
      </output>
      {result.loading ? <LoadingState label="Reconstructing run state" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {message ? <ErrorState message={message} /> : null}
      <ApprovalControls
        canDecide={state.status === "live"}
        attempts={state.attempts}
        events={state.events}
        onDecision={(nodeId, attemptId, decision) =>
          command({
            endpoint: `/runs/${encodeURIComponent(runId)}/approve`,
            method: "POST",
            body: { nodeId, attemptId, decision },
          })
        }
      />
      <RunControls
        forkSupported={Boolean(api)}
        state={state}
        onCommand={(descriptor) => void command(descriptor)}
        onReplay={() => void replayEvents(state.events, dispatchEvent)}
      />
      <DebuggerGraph
        nodes={snapshot?.topology?.nodes ?? topologyFrom(workflowResult.value)?.nodes ?? []}
        edges={snapshot?.topology?.edges ?? topologyFrom(workflowResult.value)?.edges ?? []}
        state={state}
        onNodeSelect={(nodeId) =>
          dispatch((current) => debuggerReducer(current, { type: "select_node", nodeId }))
        }
      />
      <div className="debugger-page__columns">
        <EventTimeline
          state={state}
          onEventSelect={(eventId) =>
            dispatch((current) => debuggerReducer(current, { type: "select_event", eventId }))
          }
        />
        <AttemptDetails state={state} />
      </div>
    </div>
  );
}

export function RunsPage({ api }: StudioPageProps) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const clearRunSelection = () => {
    setSelectedRun("");
    const url = new URL(window.location.href);
    url.searchParams.delete("runId");
    window.history.replaceState(window.history.state, "", url);
  };
  const result = useResource<{
    runs?: Array<{ id: string; status?: string }>;
    nextCursor?: string;
  }>(api, `/runs?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  const [selectedRun, setSelectedRun] = useState(
    () => new URLSearchParams(window.location.search).get("runId") ?? "",
  );
  const selectId = useId();
  const [runStatuses, setRunStatuses] = useState<Record<string, string>>({});
  const onStatus = useCallback((id: string, status: string) => {
    setRunStatuses((current) => (current[id] === status ? current : { ...current, [id]: status }));
  }, []);
  const runs = result.value?.runs ?? [];
  const run =
    runs.find((run) => run.id === selectedRun) ?? (selectedRun ? { id: selectedRun } : runs[0]);
  return (
    <PageFrame title="Graph runs" eyebrow="Inspect / runs">
      {result.loading ? <LoadingState label="Loading workflow runs" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error && !run ? (
        <EmptyState
          title="No graph runs"
          detail="Open a graph in the builder and choose Run saved to see its progress here."
        />
      ) : null}
      <nav aria-label="Run history pages">
        <button
          type="button"
          disabled={!cursors.length || result.loading}
          onClick={() => {
            clearRunSelection();
            setCursors((value) => value.slice(0, -1));
          }}
        >
          Newer runs
        </button>
        <button
          type="button"
          disabled={!result.value?.nextCursor || result.loading}
          onClick={() => {
            const next = result.value?.nextCursor;
            if (next) {
              clearRunSelection();
              setCursors((value) => [...value, next]);
            }
          }}
        >
          Older runs
        </button>
      </nav>
      {run ? (
        <>
          <label htmlFor={selectId}>Run history</label>
          <select
            id={selectId}
            value={run.id}
            onChange={(event) => {
              const runId = event.target.value;
              setSelectedRun(runId);
              const url = new URL(window.location.href);
              url.searchParams.set("runId", runId);
              window.history.replaceState(window.history.state, "", url);
            }}
          >
            {selectedRun && !runs.some((entry) => entry.id === selectedRun) ? (
              <option value={selectedRun}>{selectedRun}</option>
            ) : null}
            {runs.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id} · {runStatuses[entry.id] ?? entry.status}
              </option>
            ))}
          </select>

          <RunDebugger key={run.id} api={api} runId={run.id} onStatus={onStatus} />
        </>
      ) : null}
    </PageFrame>
  );
}

export function SettingsPage() {
  return (
    <PageFrame title="Studio settings" eyebrow="System / settings">
      <div className="settings-grid">
        <div className="settings-card">
          <HardDrives aria-hidden="true" />
          <strong>Local graph runtime</strong>
          <span>
            Your graphs and run history belong to this project. Keep the local server running while
            graphs execute.
          </span>
        </div>
        <div className="settings-card">
          <ShieldCheck aria-hidden="true" />
          <strong>Private by default</strong>
          <span>
            The Studio session token stays in memory. Provider credentials are managed by each CLI.
            Graph policies are checked before a run starts.
          </span>
        </div>
      </div>
    </PageFrame>
  );
}
