import { CursorClick, TerminalWindow } from "@phosphor-icons/react";
import { Background, Controls, Handle, Position, ReactFlow } from "@xyflow/react";
import { useState } from "react";
import type { DebuggerState } from "./debugger/reducer.ts";
import {
  buildDebuggerGraph,
  buildTimeline,
  type GraphInputEdge,
  type GraphInputNode,
  legalControls,
  selectDebuggerDetails,
} from "./debugger/view-model.ts";
import { ExtractionEdits, type ReviewChanges } from "./extraction-edits";
import type {
  ApiMutationDescriptor,
  ArtifactRef,
  EvidenceLink,
  ExtractionReviewModel,
  ImportedSession,
  ProviderCapability,
  StudioApiSeam,
} from "./types.ts";

function statusColor(status: string): string {
  if (["supported", "completed", "succeeded", "ready", "approved"].includes(status))
    return "var(--studio-green)";
  if (["degraded", "paused", "running", "blocked", "blocked_approval"].includes(status))
    return "var(--studio-amber)";
  if (["unavailable", "failed", "error", "rejected"].includes(status)) return "var(--studio-red)";
  return "var(--studio-text-muted)";
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="status-badge" style={{ color: statusColor(status) }}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

export interface ProviderCapabilityListProps {
  capabilities: readonly ProviderCapability[];
  status?: "loading" | "empty" | "error";
  error?: string;
}
export function ProviderCapabilityList({
  capabilities,
  status,
  error,
}: ProviderCapabilityListProps) {
  if (status === "loading")
    return (
      <section className="panel" aria-busy="true">
        Loading provider capabilities
      </section>
    );
  if (status === "error")
    return (
      <section className="panel" role="alert">
        Unable to load provider capabilities{error ? `: ${error}` : ""}
      </section>
    );
  if (status === "empty" || !capabilities.length)
    return <section className="panel">No provider capabilities reported</section>;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Provider capabilities</h2>
        <span className="panel-count">Runtime compatibility</span>
      </div>
      <div className="table-scroll">
        <table className="capability-table" aria-label="Provider capabilities">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Capability</th>
              <th>Status</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.map((item) => (
              <tr key={`${item.provider}:${item.capability}`}>
                <td>{item.provider}</td>
                <td>{item.capability.replace(/([a-z])([A-Z])/g, "$1 $2")}</td>
                <td>
                  <StatusBadge status={item.status} />
                </td>
                <td>{item.reason ?? item.source ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export interface ImportedSessionListProps {
  sessions: readonly ImportedSession[];
  selectedId?: string;
  onSelect?: (session: ImportedSession) => void;
  status?: "loading" | "empty" | "error";
  error?: string;
}
export function ImportedSessionList({
  sessions,
  selectedId,
  onSelect,
  status,
  error,
}: ImportedSessionListProps) {
  if (status === "loading")
    return (
      <section className="panel" aria-busy="true">
        Loading imported sessions
      </section>
    );
  if (status === "error")
    return (
      <section className="panel" role="alert">
        Unable to load imported sessions{error ? `: ${error}` : ""}
      </section>
    );
  if (status === "empty" || !sessions.length)
    return (
      <section className="panel details-empty">
        <TerminalWindow size={32} />
        <h2>No imported sessions</h2>
        <p>Choose a trace file above to bring your completed work into Loopy.</p>
      </section>
    );
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Imported sessions</h2>
        <span className="panel-count">{sessions.length} available</span>
      </div>
      <ul className="session-list">
        {sessions.map((session) => {
          const lossinessCount =
            (session.lossiness?.redactedEventIds?.length ?? 0) +
            Object.keys(session.lossiness?.removedFields ?? {}).length;
          return (
            <li key={session.id}>
              <button
                type="button"
                className="session-row"
                onClick={() => onSelect?.(session)}
                aria-pressed={selectedId === session.id}
              >
                <TerminalWindow className="session-row__icon" size={24} aria-hidden="true" />
                <span className="session-row__copy">
                  <strong>{session.source}</strong>
                  <small>{session.provider}</small>
                  <span className="session-row__id">{session.id}</span>
                  <small
                    style={{
                      color: lossinessCount ? "var(--studio-amber)" : "var(--studio-green)",
                    }}
                  >
                    {lossinessCount
                      ? `Lossy import · ${lossinessCount} marker${lossinessCount === 1 ? "" : "s"}`
                      : "Lossiness not reported"}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface ExtractionReviewProps {
  model: ExtractionReviewModel;
  onEvidenceSelect?: (link: EvidenceLink) => void;
  onApprove?: () => void;
  onReject?: () => void;
  actionsDisabled?: boolean;
  onSaveReview?: (changes: ReviewChanges) => Promise<void>;
}
function proposalNodeNames(proposal: ExtractionReviewModel["proposal"]): string[] {
  const workflow =
    proposal && typeof proposal === "object" && "workflow" in proposal
      ? proposal.workflow
      : undefined;
  if (
    !workflow ||
    typeof workflow !== "object" ||
    !("nodes" in workflow) ||
    !Array.isArray(workflow.nodes)
  )
    return [];
  return workflow.nodes.map((node) =>
    typeof node === "object" && node !== null && "name" in node && typeof node.name === "string"
      ? node.name
      : "Unnamed node",
  );
}
export function ExtractionReview({
  model,
  onEvidenceSelect,
  onApprove,
  onReject,
  actionsDisabled,
  onSaveReview,
}: ExtractionReviewProps) {
  const [reviewDirty, setReviewDirty] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceLink>();
  const nodeNames = proposalNodeNames(model.proposal);
  const blocked =
    model.status === "blocked" || model.status === "approved" || model.status === "rejected";
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Extraction review</h2>
        <StatusBadge status={model.status} />
      </div>
      <div className="review-columns">
        <section className="review-column">
          <h3>Imported evidence</h3>
          <p>{model.sourceLabel}</p>
          {model.lossiness ? (
            <details>
              <summary>Import completeness</summary>
              <p>
                {model.lossiness.redactedEventIds?.length ?? 0} redacted events.{" "}
                {Object.keys(model.lossiness.removedFields ?? {}).length} events with removed
                fields.
              </p>
              {model.lossiness.notes?.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <pre>{JSON.stringify(model.lossiness, null, 2)}</pre>
            </details>
          ) : (
            <p>The import does not report completeness metadata.</p>
          )}
          <ul>
            {model.evidence.map((link) => (
              <li key={link.evidenceId}>
                {link.href ? (
                  <a
                    href={link.href}
                    onClick={() => {
                      setSelectedEvidence(link);
                      onEvidenceSelect?.(link);
                    }}
                  >
                    {link.label ?? link.evidenceId}
                  </a>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setSelectedEvidence(link);
                      onEvidenceSelect?.(link);
                    }}
                  >
                    {link.label ?? link.evidenceId}
                  </button>
                )}
                {link.rationale ? <p>{link.rationale}</p> : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="review-column">
          <h3>Proposed workflow</h3>
          {nodeNames.length ? (
            <ol>
              {nodeNames.map((name, index) => (
                <li key={`${index}-${name}`}>{name}</li>
              ))}
            </ol>
          ) : (
            <pre>{JSON.stringify(model.proposal, null, 2)}</pre>
          )}
        </section>
      </div>
      {selectedEvidence ? (
        <details open className="review-evidence">
          <summary>
            Source evidence for {selectedEvidence.label ?? selectedEvidence.evidenceId}
          </summary>
          {selectedEvidence.eventIds.map((id) => {
            const event = model.sourceEvents.find((event) => event.id === id);
            return (
              <div key={id}>
                <small>{id}</small>
                <pre>
                  {event
                    ? JSON.stringify(event, null, 2)
                    : "This source event is unavailable in the imported trace."}
                </pre>
              </div>
            );
          })}
        </details>
      ) : null}
      <ExtractionEdits
        model={model}
        disabled={actionsDisabled}
        onSave={onSaveReview}
        onDirty={setReviewDirty}
      />
      {reviewDirty ? <p>Save your review changes before approving this extraction.</p> : null}
      {model.warnings?.length ? (
        <ul className="review-warnings" aria-label="Extraction warnings">
          {model.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div className="review-actions">
        <button
          className="editor-primary-button"
          type="button"
          onClick={onApprove}
          disabled={actionsDisabled || blocked || reviewDirty}
        >
          Approve and publish graph
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={actionsDisabled || model.status === "approved" || model.status === "rejected"}
        >
          Reject extraction
        </button>
      </div>
    </section>
  );
}

export function extractionApproveMutation(
  importId: string,
  proposalId: string,
): ApiMutationDescriptor<{ importId: string; proposalId: string }, unknown> {
  return {
    kind: "mutation",
    key: `extraction:approve:${proposalId}`,
    method: "POST",
    endpoint: `/api/extractions/${encodeURIComponent(proposalId || importId)}/approve`,
    body: { importId, proposalId },
  };
}

export function extractionRejectMutation(
  importId: string,
  proposalId: string,
): ApiMutationDescriptor<{ importId: string; proposalId: string }, unknown> {
  return {
    kind: "mutation",
    key: `extraction:reject:${proposalId}`,
    method: "POST",
    endpoint: `/api/extractions/${encodeURIComponent(proposalId || importId)}/reject`,
    body: { importId, proposalId },
  };
}

export interface DebuggerGraphProps {
  nodes: readonly GraphInputNode[];
  edges: readonly GraphInputEdge[];
  state: DebuggerState;
  onNodeSelect?: (nodeId: string) => void;
}
function DebuggerNode({
  data,
}: {
  data: { label: string; status: string; attemptCount: number; selected: boolean };
}) {
  return (
    <div className="debugger-node" data-selected={data.selected}>
      <Handle type="target" position={Position.Top} />
      <strong>{data.label}</strong>
      <StatusBadge status={data.status} />
      <small>
        {data.attemptCount} attempt{data.attemptCount === 1 ? "" : "s"}
      </small>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const debuggerNodeTypes = { "debugger-node": DebuggerNode };
export function DebuggerGraph({ nodes, edges, state, onNodeSelect }: DebuggerGraphProps) {
  const graph = buildDebuggerGraph(nodes, edges, state.attempts, state.selectedNodeId);
  return (
    <section className="debugger-graph" aria-label="Run graph">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={debuggerNodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.15}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_event, node) => onNodeSelect?.(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--studio-border)" gap={28} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}
export interface EventTimelineProps {
  state: DebuggerState;
  onEventSelect?: (eventId?: string) => void;
}
export function EventTimeline({ state, onEventSelect }: EventTimelineProps) {
  const [page, setPage] = useState<number>();
  const pageSize = 100;
  const lastPage = Math.max(0, Math.ceil(state.events.length / pageSize) - 1);
  const selectedIndex = state.selectedEventId
    ? state.events.findIndex((event) => (event.eventId ?? event.id) === state.selectedEventId)
    : -1;
  const currentPage = Math.min(
    page ?? (selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) : lastPage),
    lastPage,
  );
  const changePage = (next?: number) => {
    onEventSelect?.(undefined);
    setPage(next);
  };
  const items = buildTimeline(
    state.events.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
    state.selectedEventId,
  );
  if (!items.length) return <section className="panel">No events yet</section>;
  return (
    <section className="panel timeline-panel" aria-label="Ordered event timeline">
      <div className="panel-heading">
        <h2>Event timeline</h2>
        <span className="panel-count">{state.events.length} events</span>
      </div>
      <nav aria-label="Timeline pages">
        <button
          type="button"
          disabled={currentPage === 0}
          onClick={() => changePage(currentPage - 1)}
        >
          Earlier events
        </button>
        <span>
          {" "}
          {currentPage + 1} / {lastPage + 1}{" "}
        </span>
        <button
          type="button"
          disabled={currentPage === lastPage}
          onClick={() => changePage(currentPage + 1)}
        >
          Later events
        </button>
        <button
          type="button"
          disabled={page === undefined && selectedIndex < 0}
          onClick={() => changePage(undefined)}
        >
          Follow latest
        </button>
      </nav>
      <ol start={currentPage * pageSize + 1} className="timeline-list">
        {items.map((item) => (
          <li key={item.eventId}>
            <button
              type="button"
              className="timeline-event"
              onClick={() => onEventSelect?.(item.eventId)}
              aria-pressed={item.selected}
            >
              <span className="timeline-sequence">{item.sequence ?? "-"}</span>
              <span className="timeline-copy">
                <strong>{item.label}</strong>
                {item.nodeId ? (
                  <small title={item.nodeId}>
                    Node {item.nodeId.slice(0, 8)}
                    {item.attemptId ? ` / Attempt ${item.attemptId.slice(0, 8)}` : ""}
                  </small>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
export interface AttemptDetailsProps {
  state: DebuggerState;
  artifacts?: readonly ArtifactRef[];
}
function ArtifactList({ artifacts }: { artifacts: readonly ArtifactRef[] }) {
  return (
    <div>
      <h3>Artifacts</h3>
      {artifacts.length ? (
        <ul>
          {artifacts.map((artifact) => (
            <li key={artifact.id ?? artifact.name}>
              {artifact.href ? <a href={artifact.href}>{artifact.name}</a> : artifact.name}
              {artifact.sizeBytes === undefined ? "" : ` · ${artifact.sizeBytes} bytes`}
            </li>
          ))}
        </ul>
      ) : (
        <p>No artifacts</p>
      )}
    </div>
  );
}
export function AttemptDetails({ state, artifacts = state.artifacts }: AttemptDetailsProps) {
  const details = selectDebuggerDetails(state);
  if (!details.event && !details.attempt)
    return (
      <section className="panel details-empty">
        <CursorClick size={32} aria-hidden="true" />
        <h2>Follow the work</h2>
        <p>Select a node, attempt, or event to inspect details</p>
      </section>
    );
  return (
    <section className="panel details-panel" aria-label="Selected run details">
      <h2>Selected details</h2>
      {details.attempt && (
        <div>
          <p>
            <strong>Attempt:</strong> {details.attempt.attemptId}
          </p>
          <p>
            <strong>Status:</strong> <StatusBadge status={details.attempt.status} />
          </p>
          {details.attempt.error && (
            <p role="alert" style={{ color: "var(--studio-red)" }}>
              {details.attempt.error}
            </p>
          )}
          {(["input", "output"] as const).map((field) =>
            details.attempt?.[field] !== undefined ? (
              <details key={field} open>
                <summary>{field === "input" ? "Input" : "Output"}</summary>
                <pre>{JSON.stringify(details.attempt[field], null, 2)}</pre>
              </details>
            ) : null,
          )}
          <ArtifactList artifacts={details.attempt.artifacts ?? artifacts} />
        </div>
      )}
      {details.event && (
        <details open>
          <summary>Event {details.eventId}</summary>
          <pre>{JSON.stringify(details.event, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

export interface RunControlsProps {
  state: DebuggerState;
  onCommand?: (descriptor: ApiMutationDescriptor) => void;
  onReplay?: () => void;
  api?: StudioApiSeam;
  /** Fork stays opt-in until the runtime exposes durable checkpoint semantics. */
  forkSupported?: boolean;
}

export function RunControls({
  state,
  onCommand,
  onReplay,
  api,
  forkSupported = false,
}: RunControlsProps) {
  const selectedEvent = state.events.find(
    (event) => (event.eventId ?? event.id) === state.selectedEventId,
  );
  const selectedAttempt = state.selectedAttemptId
    ? state.attempts.find((attempt) => attempt.attemptId === state.selectedAttemptId)
    : state.selectedNodeId
      ? state.attempts.filter((attempt) => attempt.nodeId === state.selectedNodeId).at(-1)
      : state.attempts.find((attempt) => attempt.attemptId === selectedEvent?.attemptId);
  const controls = legalControls(state.status, selectedAttempt);
  controls.fork =
    controls.fork && forkSupported && (!selectedEvent || selectedEvent.type === "node.completed");
  const command = (name: "pause" | "resume" | "cancel" | "retry" | "fork") => {
    const body =
      name === "retry"
        ? { nodeId: selectedAttempt?.nodeId }
        : name === "fork"
          ? selectedEvent
            ? { checkpointEventId: state.selectedEventId }
            : { nodeId: selectedAttempt?.nodeId }
          : {};
    const descriptor: ApiMutationDescriptor = {
      kind: "mutation",
      key: `${name}:${state.runId}`,
      method: "POST",
      endpoint: `/api/runs/${encodeURIComponent(state.runId)}/${name}`,
      body,
    };
    onCommand?.(descriptor);
    if (api) void api.mutate(descriptor);
  };
  return (
    <div role="toolbar" aria-label="Run controls" className="run-controls">
      <button type="button" onClick={() => command("pause")} disabled={!controls.pause}>
        Pause
      </button>
      <button type="button" onClick={() => command("resume")} disabled={!controls.resume}>
        Resume
      </button>
      <button type="button" onClick={() => command("cancel")} disabled={!controls.cancel}>
        Cancel
      </button>
      <button type="button" onClick={() => command("retry")} disabled={!controls.retryFailedNode}>
        Retry failed node
      </button>
      <button
        type="button"
        onClick={onReplay}
        disabled={!controls.replay}
        aria-label="Replay events locally"
      >
        Replay events
      </button>
      <button type="button" onClick={() => command("fork")} disabled={!controls.fork}>
        Fork from checkpoint
      </button>
      {!forkSupported ? (
        <span role="note" style={{ color: "var(--studio-text-muted)" }}>
          Fork unavailable: checkpoint storage is not implemented by this runtime.
        </span>
      ) : null}
    </div>
  );
}
