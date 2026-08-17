import { Handle, Position, ReactFlow } from "@xyflow/react";
import type { DebuggerState } from "./debugger/reducer.ts";
import {
  buildDebuggerGraph,
  buildTimeline,
  type GraphInputEdge,
  type GraphInputNode,
  legalControls,
  selectDebuggerDetails,
} from "./debugger/view-model.ts";
import type {
  ApiMutationDescriptor,
  ArtifactRef,
  EvidenceLink,
  ExtractionReviewModel,
  ImportedSession,
  ProviderCapability,
  StudioApiSeam,
} from "./types.ts";

const palette = {
  bg: "#171717",
  panel: "#202020",
  border: "#3b3b3b",
  text: "#f3f0e9",
  muted: "#aaa49a",
  amber: "#e9a23b",
  red: "#ef6f61",
  green: "#71c391",
};

const panelStyle = {
  background: palette.panel,
  border: `1px solid ${palette.border}`,
  color: palette.text,
  padding: 16,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function statusColor(status: string): string {
  if (["supported", "completed", "succeeded", "ready"].includes(status)) return palette.green;
  if (["degraded", "paused", "running"].includes(status)) return palette.amber;
  if (["unavailable", "failed", "error"].includes(status)) return palette.red;
  return palette.muted;
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
      <section style={panelStyle} aria-busy="true">
        Loading provider capabilities
      </section>
    );
  if (status === "error")
    return (
      <section style={panelStyle} role="alert">
        Unable to load provider capabilities{error ? `: ${error}` : ""}
      </section>
    );
  if (status === "empty" || capabilities.length === 0)
    return <section style={panelStyle}>No provider capabilities reported</section>;
  return (
    <section style={panelStyle}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Provider capability matrix</h2>
      <table
        aria-label="Provider capabilities"
        style={{ width: "100%", borderCollapse: "collapse" }}
      >
        <thead>
          <tr
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1.5fr 110px 2fr",
              color: palette.muted,
            }}
          >
            <th style={{ textAlign: "left" }}>Provider</th>
            <th style={{ textAlign: "left" }}>Capability</th>
            <th style={{ textAlign: "left" }}>Status</th>
            <th style={{ textAlign: "left" }}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {capabilities.map((item) => (
            <tr
              key={`${item.provider}:${item.capability}`}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1.5fr 110px 2fr",
                borderTop: `1px solid ${palette.border}`,
                paddingTop: 7,
              }}
            >
              <td>{item.provider}</td>
              <td>{item.capability}</td>
              <td style={{ color: statusColor(item.status) }}>{item.status}</td>
              <td style={{ color: palette.muted }}>{item.reason ?? item.source ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <section style={panelStyle} aria-busy="true">
        Loading imported sessions
      </section>
    );
  if (status === "error")
    return (
      <section style={panelStyle} role="alert">
        Unable to load imported sessions{error ? `: ${error}` : ""}
      </section>
    );
  if (status === "empty" || sessions.length === 0)
    return <section style={panelStyle}>No imported sessions</section>;
  return (
    <section style={panelStyle}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Imported sessions</h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 7 }}>
        {sessions.map((session) => {
          const lossinessCount =
            (session.lossiness?.redactedEventIds?.length ?? 0) +
            Object.keys(session.lossiness?.removedFields ?? {}).length;
          return (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => onSelect?.(session)}
                aria-pressed={selectedId === session.id}
                style={{
                  width: "100%",
                  textAlign: "left",
                  color: palette.text,
                  background: selectedId === session.id ? "#3a2d1c" : "transparent",
                  border: `1px solid ${selectedId === session.id ? palette.amber : palette.border}`,
                  padding: 10,
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "block" }}>{session.id}</span>
                <span style={{ display: "block", color: palette.muted, fontSize: 12 }}>
                  {session.provider} · {session.source}
                </span>
                {lossinessCount > 0 ? (
                  <span style={{ display: "block", color: palette.amber, fontSize: 12 }}>
                    Lossy import · {lossinessCount} marker{lossinessCount === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span style={{ display: "block", color: palette.green, fontSize: 12 }}>
                    Lossiness not reported
                  </span>
                )}
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
}: ExtractionReviewProps) {
  const nodeNames = proposalNodeNames(model.proposal);
  const blocked =
    model.status === "blocked" || model.status === "approved" || model.status === "rejected";
  return (
    <section style={panelStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "baseline",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Extraction review</h2>
        <span style={{ color: statusColor(model.status) }}>{model.status}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <section style={{ border: `1px solid ${palette.border}`, padding: 10 }}>
          <h3 style={{ marginTop: 0, fontSize: 13 }}>Imported evidence</h3>
          <p style={{ color: palette.muted, fontSize: 12 }}>{model.sourceLabel}</p>
          {model.lossiness && (
            <p style={{ color: palette.amber, fontSize: 12 }}>
              Lossiness is preserved and must be considered before approval.
            </p>
          )}
          <ul>
            {model.evidence.map((link) => (
              <li key={link.evidenceId}>
                {link.href ? (
                  <a
                    href={link.href}
                    onClick={() => onEvidenceSelect?.(link)}
                    style={{ color: palette.amber }}
                  >
                    {link.label ?? link.evidenceId}
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => onEvidenceSelect?.(link)}
                    style={{
                      color: palette.amber,
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    {link.label ?? link.evidenceId}
                  </button>
                )}
                {link.rationale ? (
                  <span style={{ color: palette.muted }}> · {link.rationale}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section style={{ border: `1px solid ${palette.border}`, padding: 10 }}>
          <h3 style={{ marginTop: 0, fontSize: 13 }}>Proposed workflow</h3>
          {nodeNames.length ? (
            <ol>
              {nodeNames.map((name) => (
                <li key={`node-${name}`}>{name}</li>
              ))}
            </ol>
          ) : (
            <pre style={{ overflow: "auto", fontSize: 11 }}>
              {JSON.stringify(model.proposal, null, 2)}
            </pre>
          )}
        </section>
      </div>
      {model.warnings?.length ? (
        <ul aria-label="Extraction warnings" style={{ color: palette.amber }}>
          {model.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button
          type="button"
          onClick={onApprove}
          disabled={actionsDisabled || blocked}
          style={{
            color: palette.bg,
            background: palette.amber,
            border: 0,
            padding: "8px 12px",
            cursor: "pointer",
          }}
        >
          Approve extraction
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={actionsDisabled || blocked}
          style={{
            color: palette.text,
            background: "transparent",
            border: `1px solid ${palette.border}`,
            padding: "8px 12px",
            cursor: "pointer",
          }}
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
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${data.selected ? palette.amber : palette.border}`,
        color: palette.text,
        minWidth: 150,
        padding: 10,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <strong>{data.label}</strong>
      <span style={{ display: "block", color: statusColor(data.status), fontSize: 11 }}>
        {data.status} · {data.attemptCount} attempt{data.attemptCount === 1 ? "" : "s"}
      </span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function DebuggerGraph({ nodes, edges, state, onNodeSelect }: DebuggerGraphProps) {
  const graph = buildDebuggerGraph(nodes, edges, state.attempts, state.selectedNodeId);
  const nodeTypes = { "debugger-node": DebuggerNode };
  return (
    <section
      aria-label="Run graph"
      style={{ height: 380, background: palette.bg, border: `1px solid ${palette.border}` }}
    >
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        fitView
        onNodeClick={(_event: unknown, node: { id: string }) => onNodeSelect?.(node.id)}
        proOptions={{ hideAttribution: true }}
      />
    </section>
  );
}

export interface EventTimelineProps {
  state: DebuggerState;
  onEventSelect?: (eventId: string) => void;
}

export function EventTimeline({ state, onEventSelect }: EventTimelineProps) {
  const items = buildTimeline(state.events, state.selectedEventId);
  if (!items.length) return <section style={panelStyle}>No events yet</section>;
  return (
    <section style={panelStyle} aria-label="Ordered event timeline">
      <ol style={{ margin: 0, paddingLeft: 22 }}>
        {items.map((item) => (
          <li
            key={item.eventId}
            style={{ padding: "6px 0", color: item.selected ? palette.amber : palette.text }}
          >
            <button
              type="button"
              onClick={() => onEventSelect?.(item.eventId)}
              aria-pressed={item.selected}
              style={{
                background: "transparent",
                border: 0,
                color: "inherit",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ color: palette.muted, marginRight: 8 }}>{item.sequence ?? "-"}</span>
              {item.label}
              {item.nodeId ? ` · node ${item.nodeId}` : ""}
              {item.attemptId ? ` · attempt ${item.attemptId}` : ""}
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
      <h3 style={{ fontSize: 13 }}>Artifacts</h3>
      {artifacts.length ? (
        <ul>
          {artifacts.map((artifact) => (
            <li key={artifact.id ?? artifact.name}>
              {artifact.href ? (
                <a href={artifact.href} style={{ color: palette.amber }}>
                  {artifact.name}
                </a>
              ) : (
                artifact.name
              )}
              {artifact.sizeBytes === undefined ? "" : ` · ${artifact.sizeBytes} bytes`}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: palette.muted }}>No artifacts</p>
      )}
    </div>
  );
}

export function AttemptDetails({ state, artifacts = state.artifacts }: AttemptDetailsProps) {
  const details = selectDebuggerDetails(state);
  if (!details.event && !details.attempt)
    return (
      <section style={panelStyle}>Select a node, attempt, or event to inspect details</section>
    );
  return (
    <section style={panelStyle} aria-label="Selected run details">
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Selected details</h2>
      {details.attempt && (
        <div>
          <p>
            <strong>Attempt:</strong> {details.attempt.attemptId}
          </p>
          <p>
            <strong>Status:</strong>{" "}
            <span style={{ color: statusColor(details.attempt.status) }}>
              {details.attempt.status}
            </span>
          </p>
          {details.attempt.error && (
            <p role="alert" style={{ color: palette.red }}>
              {details.attempt.error}
            </p>
          )}
          <ArtifactList artifacts={details.attempt.artifacts ?? artifacts} />
        </div>
      )}
      {details.event && (
        <details open>
          <summary>Event {details.eventId}</summary>
          <pre style={{ overflow: "auto", fontSize: 11 }}>
            {JSON.stringify(details.event, null, 2)}
          </pre>
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
  const selectedAttempt = state.selectedAttemptId
    ? state.attempts.find((attempt) => attempt.attemptId === state.selectedAttemptId)
    : state.selectedNodeId
      ? state.attempts.filter((attempt) => attempt.nodeId === state.selectedNodeId).at(-1)
      : undefined;
  const controls = legalControls(state.status, selectedAttempt);
  controls.fork = controls.fork && forkSupported;
  const command = (name: "pause" | "resume" | "cancel" | "retry" | "fork") => {
    const body =
      name === "retry"
        ? { nodeId: selectedAttempt?.nodeId }
        : name === "fork"
          ? { checkpointEventId: state.selectedEventId }
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
    <div
      role="toolbar"
      aria-label="Run controls"
      style={{ ...panelStyle, display: "flex", gap: 8, flexWrap: "wrap" }}
    >
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
        <span role="note" style={{ color: palette.muted }}>
          Fork unavailable: checkpoint storage is not implemented by this runtime.
        </span>
      ) : null}
    </div>
  );
}
