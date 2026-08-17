import { useEffect, useId, useState } from "react";
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

function useResource<T>(api: ApiClient | undefined, path: string) {
  const [state, setState] = useState<{ value?: T; error?: string; loading: boolean }>({
    loading: Boolean(api),
  });
  useEffect(() => {
    if (!api) return;
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
  const review = result.value?.reviews?.[0];
  return (
    <PageFrame title="Trace extractions" eyebrow="Inspect / extractions">
      {result.loading ? <LoadingState label="Loading extraction reviews" /> : null}
      {result.error ? <ErrorState message={result.error} /> : null}
      {!result.loading && !result.error && review ? <ExtractionReview model={review} /> : null}
      {!result.loading && !result.error && !review ? (
        <EmptyState
          title="No extraction proposals"
          detail="Import a session to generate a reviewable workflow proposal."
        />
      ) : null}
    </PageFrame>
  );
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
              <strong>{workflow.workflowId ?? "Unnamed workflow"}</strong>
              <span>version {workflow.version ?? index + 1}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </PageFrame>
  );
}

function snapshotFrom(value: unknown, runId: string): DebuggerSnapshot {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const events = Array.isArray(source.events) ? (source.events as DebuggerEvent[]) : [];
  return {
    runId,
    status: typeof source.status === "string" ? source.status : "loading",
    events,
    attempts: Array.isArray(source.attempts) ? source.attempts : undefined,
    artifacts: Array.isArray(source.artifacts) ? source.artifacts : undefined,
  };
}

function RunDebugger({ api, runId }: { api?: ApiClient; runId: string }) {
  const result = useResource<unknown>(api, `/runs/${encodeURIComponent(runId)}`);
  const [state, dispatch] = useState(() => createDebuggerState(runId));
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (!result.value) return;
    const snapshot = snapshotFrom(result.value, runId);
    dispatch(debuggerReducer(createDebuggerState(runId), { type: "snapshot", snapshot }));
  }, [result.value, runId]);
  useEffect(() => {
    if (!api || result.error) return;
    return api.streamEvents(
      runId,
      (event) =>
        dispatch((current) =>
          debuggerReducer(current, { type: "event", event: event as DebuggerEvent }),
        ),
      {
        afterSequence: -1,
        onError: (error) => setMessage(error.message),
      },
    );
  }, [api, result.error, runId]);
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
        nodes={[]}
        edges={[]}
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
