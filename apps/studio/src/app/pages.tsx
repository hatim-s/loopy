import { Link } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState } from "react";
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
import type { GraphInputEdge, GraphInputNode } from "../features/debugger";
import { createDebuggerState, debuggerReducer, replayEvents } from "../features/debugger";
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
  const [state, setState] = useState<{ value?: T; error?: string; loading: boolean }>({
    loading: Boolean(api && path),
  });
  useEffect(() => {
    if (!api || !path) {
      setState({ loading: false });
      return;
    }
    let active = true;
    setState({ loading: true });
    void api
      .request<T>(path)
      .then((value) => active && setState({ value, loading: false }))
      .catch((error: unknown) => {
        if (active)
          setState({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
    };
  }, [api, path]);
  return state;
}

function PageFrame({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  const titleId = `feature-page-title-${useId().replaceAll(":", "")}`;
  return (
    <section className="feature-page" aria-labelledby={titleId}>
      <div className="feature-page__heading">
        <div>
          <div className="feature-slot__eyebrow">{eyebrow}</div>
          <h1 id={titleId}>{title}</h1>
        </div>
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
    <PageFrame title="Provider connections" eyebrow="Build / providers">
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
  const result = useResource<{ sessions?: ImportedSession[] }>(api, "/sessions");
  return (
    <PageFrame title="Agent sessions" eyebrow="Inspect / sessions">
      <p className="feature-page__lede">
        Imported traces are kept local and retain their provider provenance.
      </p>
      {result.loading ? <LoadingState label="Loading imported sessions" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error ? (
        <ImportedSessionList
          sessions={result.value?.sessions ?? []}
          status={result.value?.sessions?.length ? undefined : "empty"}
        />
      ) : null}
      <span className="sr-only">Waiting for feature data</span>
    </PageFrame>
  );
}

export function ExtractionsPage({ api }: StudioPageProps) {
  const result = useResource<{ reviews?: ExtractionReviewModel[]; jobs?: unknown[] }>(
    api,
    "/extractions",
  );
  const [pendingAction, setPendingAction] = useState<"approve" | "reject">();
  const [decision, setDecision] = useState<"approved" | "rejected">();
  const [actionError, setActionError] = useState<string>();
  const rawReview = result.value?.reviews?.[0];
  const review = rawReview ? normalizeExtractionReview(rawReview) : undefined;
  const submitDecision = async (action: "approve" | "reject") => {
    if (!api || !review) return;
    setPendingAction(action);
    setActionError(undefined);
    try {
      await api.request(
        `/extractions/${encodeURIComponent(review.proposalId ?? review.importId)}/${action}`,
        {
          method: "POST",
          body: JSON.stringify(action === "reject" ? { reason: "Rejected in Studio" } : {}),
        },
      );
      setDecision(action === "approve" ? "approved" : "rejected");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(undefined);
    }
  };
  return (
    <PageFrame title="Trace extractions" eyebrow="Inspect / extractions">
      {result.loading ? <LoadingState label="Loading extraction reviews" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {actionError ? (
        <ErrorState message={`Unable to ${pendingAction ?? "update"} extraction: ${actionError}`} />
      ) : null}
      {!result.loading && !result.error && review ? (
        <ExtractionReview
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
  return {
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
  const result = useResource<{
    workflows?: Array<{ workflowId?: string; version?: number; definition?: unknown }>;
  }>(api, "/workflows");
  return (
    <PageFrame title="Workflow library" eyebrow="Build / workflows">
      {result.loading ? <LoadingState label="Loading workflows" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error && !result.value?.workflows?.length ? (
        <EmptyState
          title="No workflows yet"
          detail="Approved extractions become versioned local workflows."
        />
      ) : null}
      {result.value?.workflows?.length ? (
        <ul className="data-list" aria-label="Workflow versions">
          {result.value.workflows.map((workflow, index) => (
            <li
              className="data-list__row"
              key={`${workflow.workflowId ?? "workflow"}:${workflow.version ?? index}`}
            >
              <Link
                to="/workflows/$workflowId/edit"
                params={{ workflowId: workflow.workflowId ?? "" }}
                className="workflow-library-link"
              >
                <strong>{workflow.workflowId ?? "Unnamed workflow"}</strong>
                <span>version {workflow.version ?? index + 1} · Edit graph</span>
              </Link>
            </li>
          ))}
        </ul>
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

function RunDebugger({ api, runId }: { api?: ApiClient; runId: string }) {
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
  useEffect(() => {
    if (!snapshot) return;
    dispatch(debuggerReducer(createDebuggerState(runId), { type: "snapshot", snapshot }));
  }, [runId, snapshot]);
  useEffect(() => {
    if (!api || result.error) return;
    return api.streamEvents(
      runId,
      (event) =>
        dispatch((current) =>
          debuggerReducer(current, { type: "event", event: event as DebuggerEvent }),
        ),
      {
        afterSequence: snapshot?.events.reduce(
          (max, event) => Math.max(max, event.sequence ?? max),
          -1,
        ),
        onError: (error) => setMessage(error.message),
      },
    );
  }, [api, result.error, runId, snapshot?.events]);
  const dispatchEvent = (event: DebuggerEvent) =>
    dispatch((current) => debuggerReducer(current, { type: "event", event }));
  const command = async (descriptor: { endpoint: string; method: string; body?: unknown }) => {
    if (!api) return;
    try {
      await api.request(descriptor.endpoint, {
        method: descriptor.method,
        body: JSON.stringify(descriptor.body ?? {}),
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="debugger-page">
      {result.loading ? <LoadingState label="Reconstructing run state" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {message ? <ErrorState message={message} /> : null}
      <RunControls
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
  const result = useResource<{ runs?: Array<{ id: string; status?: string }> }>(api, "/runs");
  const run = result.value?.runs?.[0];
  return (
    <PageFrame title="Workflow runs" eyebrow="Inspect / runs">
      {result.loading ? <LoadingState label="Loading workflow runs" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error && !run ? (
        <EmptyState
          title="No workflow runs"
          detail="Start a workflow from the local API to inspect its live trace."
        />
      ) : null}
      {run ? <RunDebugger api={api} runId={run.id} /> : null}
    </PageFrame>
  );
}

export function SettingsPage() {
  return (
    <PageFrame title="Studio settings" eyebrow="System / settings">
      <div className="settings-card">
        <strong>Local-only runtime</strong>
        <span>
          Credentials stay in memory and requests are restricted to the configured loopback origin.
        </span>
      </div>
    </PageFrame>
  );
}
