import type {
  Capability,
  ExtractionProposal,
  JsonObject,
  ProviderId,
  TraceEvent,
} from "@loopy/contracts";

export type StudioStatus =
  | "loading"
  | "empty"
  | "error"
  | "live"
  | "paused"
  | "failed"
  | "completed";

export type CapabilityStatus = "supported" | "degraded" | "unavailable";

export interface ProviderCapability {
  provider: ProviderId | string;
  capability: Capability | string;
  status: CapabilityStatus;
  reason?: string;
  source?: string;
}

export interface ImportedSessionLossiness {
  redactedEventIds?: readonly string[];
  removedFields?: Readonly<Record<string, readonly string[]>>;
  notes?: readonly string[];
  [key: string]: unknown;
}

export interface ImportedSession {
  id: string;
  provider: ProviderId | string;
  source: string;
  createdAt?: string;
  eventCount?: number;
  sessionId?: string;
  capabilities?: Readonly<Record<string, unknown>>;
  lossiness?: ImportedSessionLossiness;
  status?: "ready" | "degraded" | "failed";
  metadata?: JsonObject;
}

export interface EvidenceLink {
  evidenceId: string;
  eventIds: readonly string[];
  label?: string;
  rationale?: string;
  href?: string;
}

export interface ExtractionReviewModel {
  importId: string;
  proposalId?: string;
  sourceLabel: string;
  sourceEvents: readonly TraceEvent[];
  proposal: ExtractionProposal | JsonObject;
  evidence: readonly EvidenceLink[];
  lossiness?: ImportedSessionLossiness;
  status: "draft" | "approved" | "rejected" | "blocked";
  warnings?: readonly string[];
}

export interface ApiQueryDescriptor<T = unknown> {
  kind: "query";
  key: readonly unknown[];
  endpoint: string;
  params?: Readonly<Record<string, string | number | boolean | undefined>>;
  select?: (value: unknown) => T;
}

export interface ApiMutationDescriptor<TBody = unknown, TResult = unknown> {
  kind: "mutation";
  key: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  endpoint: string;
  body?: TBody;
  optimistic?: boolean;
  select?: (value: unknown) => TResult;
}

export interface StudioApiSeam {
  query<T>(descriptor: ApiQueryDescriptor<T>): Promise<T>;
  mutate<TBody, TResult>(descriptor: ApiMutationDescriptor<TBody, TResult>): Promise<TResult>;
  subscribe?(runId: string, onEvent: (event: TraceEvent) => void): () => void;
}

export interface ArtifactRef {
  id?: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  sourcePath?: string;
  content?: string;
  href?: string;
}

export interface NodeAttempt {
  attemptId: string;
  nodeId: string;
  attempt: number;
  status: string;
  startedAt?: string;
  endedAt?: string;
  input?: JsonObject;
  output?: JsonObject;
  error?: string;
  artifacts?: readonly ArtifactRef[];
}

export interface DebuggerEvent {
  id?: string;
  eventId?: string;
  sequence?: number;
  type: string;
  runId?: string;
  nodeId?: string;
  attemptId?: string;
  sessionId?: string;
  occurredAt?: string;
  monotonicOffsetMs?: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DebuggerSnapshot {
  runId: string;
  workflowId?: string;
  status: StudioStatus | string;
  events: readonly DebuggerEvent[];
  attempts?: readonly NodeAttempt[];
  artifacts?: readonly ArtifactRef[];
  updatedAt?: string;
}
