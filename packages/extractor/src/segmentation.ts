import { createHash } from "node:crypto";
import { type TraceEvent, TraceEventSchema } from "@loopy/contracts";
import {
  createEvidenceReferences,
  type EvidenceKind,
  type EvidenceReference,
  type EvidenceWarning,
  validateCausalReferences,
} from "./evidence.js";
import {
  type CandidateVariable,
  classifyFeatures,
  type FeatureObservation,
  inferCandidateVariables,
} from "./features.js";

export interface CapabilityMetadata {
  provider?: string;
  supported?: readonly string[];
  degraded?: Readonly<Record<string, string>>;
  unavailable?: Readonly<Record<string, string>>;
  /** Optional provider-style report projection; status is intentionally structural. */
  capabilities?: Readonly<
    Record<string, { status: "supported" | "degraded" | "unavailable"; reason?: string }>
  >;
}

export interface LossinessMetadata {
  redactedEventIds?: readonly string[];
  removedFields?: Readonly<Record<string, readonly string[]>>;
  notes?: readonly string[];
}

export interface ExtractionWarning {
  code:
    | "invalid_event"
    | "mixed_runs"
    | "duplicate_event_id"
    | "duplicate_sequence"
    | "out_of_order"
    | "sequence_gap"
    | "invalid_causal_reference"
    | "degraded_capability"
    | "lossy_event"
    | "unmatched_verification_result"
    | "duplicate_verification_result";
  message: string;
  inputIndex?: number;
  eventId?: string;
  referencedEventId?: string;
}

export interface NormalizedTrace {
  events: TraceEvent[];
  warnings: ExtractionWarning[];
}

export interface CausalityGroup {
  groupId: string;
  rootSessionId: string;
  sessionIds: string[];
  eventIds: string[];
  childSessionIds: string[];
  depth: number;
  subagent: boolean;
}

export interface GoalEpisode {
  episodeId: string;
  key: string;
  nodeId?: string;
  attemptId?: string;
  sessionId?: string;
  eventIds: string[];
  firstSequence: number;
  lastSequence: number;
  causalityGroupId?: string;
}

export interface ToolCluster {
  clusterId: string;
  sessionId?: string;
  attemptId?: string;
  toolNames: string[];
  toolCallIds: string[];
  eventIds: string[];
  firstSequence: number;
  lastSequence: number;
}

export interface FailureSegment {
  failureId: string;
  kind:
    | "attempt_failed"
    | "attempt_cancelled"
    | "tool_denied"
    | "node_blocked"
    | "provider_failed"
    | "run_failed";
  eventIds: string[];
  recoveryEventIds: string[];
  resolved: boolean;
}

export interface VerificationSegment {
  verificationId: string;
  check?: string;
  eventIds: string[];
  result?: "passed" | "failed" | "skipped";
}

export interface SegmentationInput {
  events: readonly unknown[];
  capabilities?: CapabilityMetadata;
  lossiness?: LossinessMetadata;
}

export interface SegmentationResult {
  events: TraceEvent[];
  warnings: ExtractionWarning[];
  causality: CausalityGroup[];
  goalEpisodes: GoalEpisode[];
  toolClusters: ToolCluster[];
  failures: FailureSegment[];
  recoveries: FailureSegment[];
  verification: VerificationSegment[];
  features: FeatureObservation[];
  candidateVariables: CandidateVariable[];
  evidence: EvidenceReference[];
  evidenceWarnings: EvidenceWarning[];
  metadata: { capabilities?: CapabilityMetadata; lossiness?: LossinessMetadata };
}

function stableId(prefix: string, values: readonly string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(`${prefix}\0${[...new Set(values)].sort().join("\0")}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function payload(event: TraceEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

function stringField(event: TraceEvent, field: string): string | undefined {
  const value = payload(event)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse, validate, and canonically order a run's events. Invalid values are dropped with warnings. */
export function validateAndSortTraceEvents(input: readonly unknown[]): NormalizedTrace {
  const warnings: ExtractionWarning[] = [];
  const valid: Array<{ event: TraceEvent; inputIndex: number }> = [];
  for (const [inputIndex, value] of input.entries()) {
    const parsed = TraceEventSchema.safeParse(value);
    if (!parsed.success) {
      warnings.push({
        code: "invalid_event",
        message: parsed.error.issues[0]?.message ?? "Trace event failed schema validation.",
        inputIndex,
      });
      continue;
    }
    valid.push({ event: parsed.data, inputIndex });
  }
  const original = valid.map(({ event }) => event.id);
  const events = valid
    .slice()
    .sort(
      (left, right) =>
        left.event.sequence - right.event.sequence ||
        left.event.monotonicOffsetMs - right.event.monotonicOffsetMs ||
        left.event.occurredAt.localeCompare(right.event.occurredAt) ||
        left.event.id.localeCompare(right.event.id) ||
        left.inputIndex - right.inputIndex,
    )
    .map(({ event }) => event);
  if (JSON.stringify(original) !== JSON.stringify(events.map((event) => event.id)))
    warnings.push({
      code: "out_of_order",
      message: "Events were not in canonical sequence order.",
    });
  const seenIds = new Set<string>();
  const seenSequences = new Set<number>();
  let previousSequence: number | undefined;
  const runIds = new Set<string>();
  for (const event of events) {
    runIds.add(event.runId);
    if (seenIds.has(event.id))
      warnings.push({
        code: "duplicate_event_id",
        message: `Event '${event.id}' occurs more than once.`,
        eventId: event.id,
      });
    seenIds.add(event.id);
    if (seenSequences.has(event.sequence))
      warnings.push({
        code: "duplicate_sequence",
        message: `Sequence ${event.sequence} occurs more than once.`,
        eventId: event.id,
      });
    seenSequences.add(event.sequence);
    if (previousSequence !== undefined && event.sequence > previousSequence + 1)
      warnings.push({
        code: "sequence_gap",
        message: `Sequence gap between ${previousSequence} and ${event.sequence}.`,
        eventId: event.id,
      });
    previousSequence = event.sequence;
  }
  if (runIds.size > 1)
    warnings.push({
      code: "mixed_runs",
      message: `Input contains ${runIds.size} run IDs; segmentation preserves them together but replay must choose one.`,
    });
  warnings.sort(
    (a, b) =>
      (a.inputIndex ?? Number.MAX_SAFE_INTEGER) - (b.inputIndex ?? Number.MAX_SAFE_INTEGER) ||
      (a.eventId ?? "").localeCompare(b.eventId ?? "") ||
      a.code.localeCompare(b.code),
  );
  return { events, warnings };
}

function sessionParents(events: readonly TraceEvent[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "provider.session_started" || !event.sessionId) continue;
    const parent = stringField(event, "parentSessionId");
    if (parent) parents.set(event.sessionId, parent);
  }
  return parents;
}

function buildCausality(events: readonly TraceEvent[]): {
  groups: CausalityGroup[];
  warnings: ExtractionWarning[];
} {
  const warnings: ExtractionWarning[] = [];
  const parents = sessionParents(events);
  const knownSessions = new Set(
    events.flatMap((event) => (event.sessionId ? [event.sessionId] : [])),
  );
  const byEventId = new Map(events.map((event) => [event.id, event]));
  const roots = new Map<string, { root: string; depth: number }>();
  const resolve = (sessionId: string): { root: string; depth: number } => {
    const cached = roots.get(sessionId);
    if (cached) return cached;
    const path = new Set<string>();
    let cursor = sessionId;
    let depth = 0;
    while (parents.has(cursor)) {
      if (path.has(cursor)) {
        warnings.push({
          code: "invalid_causal_reference",
          message: `Session parent references contain a cycle at '${cursor}'.`,
          referencedEventId: cursor,
        });
        break;
      }
      path.add(cursor);
      const parent = parents.get(cursor);
      if (!parent) break;
      depth++;
      cursor = parent;
    }
    const resolved = { root: cursor, depth };
    roots.set(sessionId, resolved);
    return resolved;
  };
  for (const [child, parent] of parents) {
    if (!knownSessions.has(parent))
      warnings.push({
        code: "invalid_causal_reference",
        message: `Session '${child}' references missing parent session '${parent}'.`,
        referencedEventId: parent,
      });
  }
  const byRoot = new Map<string, { sessionIds: Set<string>; eventIds: string[]; depth: number }>();
  for (const event of events) {
    const session = event.sessionId;
    const rootInfo = session ? resolve(session) : { root: `run:${event.runId}`, depth: 0 };
    let causalRoot = rootInfo.root;
    if (!session && event.parentEventId) {
      const path = new Set<string>();
      let cursor: string | undefined = event.parentEventId;
      while (cursor && !path.has(cursor)) {
        path.add(cursor);
        const parent = byEventId.get(cursor);
        if (!parent) break;
        if (parent.sessionId) {
          causalRoot = resolve(parent.sessionId).root;
          break;
        }
        if (!parent.parentEventId) {
          causalRoot = `event:${parent.id}`;
          break;
        }
        cursor = parent.parentEventId;
      }
    }
    const group = byRoot.get(causalRoot) ?? {
      sessionIds: new Set<string>(),
      eventIds: [],
      depth: rootInfo.depth,
    };
    if (session) group.sessionIds.add(session);
    group.eventIds.push(event.id);
    group.depth = Math.min(group.depth, rootInfo.depth);
    byRoot.set(causalRoot, group);
  }
  const groups = [...byRoot.entries()]
    .map(([rootSessionId, group]) => {
      const sessionIds = [...group.sessionIds].sort();
      const eventIds = group.eventIds.slice();
      return {
        groupId: stableId("causality", eventIds),
        rootSessionId,
        sessionIds,
        eventIds,
        childSessionIds: sessionIds.filter((id) => id !== rootSessionId).sort(),
        depth: group.depth,
        subagent: group.depth > 0 || sessionIds.some((id) => parents.has(id)),
      };
    })
    .sort((a, b) => a.eventIds[0]?.localeCompare(b.eventIds[0] ?? "") ?? 0);
  return { groups, warnings };
}

function contextKey(event: TraceEvent): string {
  return event.nodeId && event.attemptId
    ? `${event.nodeId}/${event.attemptId}`
    : event.sessionId
      ? `session/${event.sessionId}`
      : `run/${event.runId}`;
}

function buildGoalEpisodes(
  events: readonly TraceEvent[],
  causality: readonly CausalityGroup[],
): GoalEpisode[] {
  const episodes: GoalEpisode[] = [];
  let current: GoalEpisode | undefined;
  const groupFor = (id: string) => causality.find((group) => group.eventIds.includes(id))?.groupId;
  for (const event of events) {
    const key = contextKey(event);
    if (!current || current.key !== key) {
      current = {
        episodeId: stableId("episode", [event.id]),
        key,
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        eventIds: [],
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        ...(groupFor(event.id) ? { causalityGroupId: groupFor(event.id) } : {}),
      };
      episodes.push(current);
    }
    current.eventIds.push(event.id);
    current.lastSequence = event.sequence;
  }
  return episodes;
}

const TOOL_TYPES = new Set(["tool.requested", "tool.started", "tool.completed", "tool.denied"]);
function buildToolClusters(events: readonly TraceEvent[]): ToolCluster[] {
  const clusters: ToolCluster[] = [];
  let current: ToolCluster | undefined;
  for (const event of events) {
    if (!TOOL_TYPES.has(event.type)) {
      current = undefined;
      continue;
    }
    const sessionId = event.sessionId;
    const attemptId = event.attemptId;
    if (
      !current ||
      current.sessionId !== sessionId ||
      current.attemptId !== attemptId ||
      event.sequence > current.lastSequence + 1
    ) {
      current = {
        clusterId: stableId("tools", [event.id]),
        ...(sessionId ? { sessionId } : {}),
        ...(attemptId ? { attemptId } : {}),
        toolNames: [],
        toolCallIds: [],
        eventIds: [],
        firstSequence: event.sequence,
        lastSequence: event.sequence,
      };
      clusters.push(current);
    }
    const tool = stringField(event, "tool");
    if (tool && !current.toolNames.includes(tool)) current.toolNames.push(tool);
    if (event.toolCallId && !current.toolCallIds.includes(event.toolCallId))
      current.toolCallIds.push(event.toolCallId);
    current.eventIds.push(event.id);
    current.lastSequence = event.sequence;
  }
  return clusters;
}

const FAILURE_TYPES = new Map<string, FailureSegment["kind"]>([
  ["attempt.failed", "attempt_failed"],
  ["attempt.cancelled", "attempt_cancelled"],
  ["tool.denied", "tool_denied"],
  ["node.blocked", "node_blocked"],
  ["run.completed", "run_failed"],
]);
const RECOVERY_TYPES = new Set(["attempt.retrying", "runtime.recovery", "run.resumed"]);

function failureKind(event: TraceEvent): FailureSegment["kind"] | undefined {
  const direct = FAILURE_TYPES.get(event.type);
  if (direct) return direct;
  if (event.type !== "provider.session_ended") return undefined;
  const status = stringField(event, "status");
  if (status === "failed") return "provider_failed";
  if (status === "cancelled") return "attempt_cancelled";
  return undefined;
}

function buildFailures(events: readonly TraceEvent[]): {
  failures: FailureSegment[];
  recoveries: FailureSegment[];
} {
  const failures: FailureSegment[] = [];
  for (const [index, event] of events.entries()) {
    const kind = failureKind(event);
    const runFailed = event.type === "run.completed" && stringField(event, "status") === "failed";
    if (!kind || (event.type === "run.completed" && !runFailed)) continue;
    const recoveryEventIds = events
      .slice(index + 1)
      .filter(
        (candidate) =>
          RECOVERY_TYPES.has(candidate.type) &&
          (candidate.nodeId === event.nodeId || !event.nodeId),
      )
      .map((candidate) => candidate.id)
      .slice(0, 1);
    failures.push({
      failureId: stableId("failure", [event.id]),
      kind,
      eventIds: [event.id],
      recoveryEventIds,
      resolved: recoveryEventIds.length > 0,
    });
  }
  const recoveries = failures
    .filter((failure) => failure.recoveryEventIds.length > 0)
    .map((failure) => ({
      ...failure,
      failureId: stableId("recovery", failure.recoveryEventIds),
      eventIds: failure.recoveryEventIds,
      recoveryEventIds: [],
      resolved: true,
    }));
  return { failures, recoveries };
}

function verificationKey(event: TraceEvent): string {
  return [
    event.nodeId ?? "",
    event.attemptId ?? "",
    event.sessionId ?? "",
    event.parentEventId ?? "",
    stringField(event, "check") ?? "",
  ].join("\0");
}

function buildVerification(events: readonly TraceEvent[]): {
  segments: VerificationSegment[];
  warnings: ExtractionWarning[];
} {
  const segments: VerificationSegment[] = [];
  const open = new Map<string, VerificationSegment[]>();
  const closed = new Set<string>();
  const warnings: ExtractionWarning[] = [];
  for (const event of events) {
    if (event.type === "verification.started") {
      const segment = {
        verificationId: stableId("verification", [event.id]),
        check: stringField(event, "check"),
        eventIds: [event.id],
      };
      segments.push(segment);
      const key = verificationKey(event);
      open.set(key, [...(open.get(key) ?? []), segment]);
    } else if (event.type === "verification.result") {
      const key = verificationKey(event);
      const pending = open.get(key);
      const current = pending?.shift();
      if (pending && pending.length === 0) open.delete(key);
      if (!current) {
        warnings.push({
          code: closed.has(key) ? "duplicate_verification_result" : "unmatched_verification_result",
          message: closed.has(key)
            ? `Verification result '${event.id}' duplicates a result for check '${stringField(event, "check") ?? "unknown"}'.`
            : `Verification result '${event.id}' has no matching verification start for check '${stringField(event, "check") ?? "unknown"}'.`,
          eventId: event.id,
        });
        continue;
      }
      current.eventIds.push(event.id);
      const status = stringField(event, "status");
      if (status === "passed" || status === "failed" || status === "skipped")
        current.result = status;
      closed.add(key);
    }
  }
  return { segments, warnings };
}

function capabilityWarnings(capabilities: CapabilityMetadata | undefined): ExtractionWarning[] {
  const structural = Object.entries(capabilities?.capabilities ?? {})
    .filter(([, assessment]) => assessment.status !== "supported")
    .map(([name, assessment]) => [name, assessment.reason ?? assessment.status] as const);
  const explicit = Object.entries({
    ...(capabilities?.degraded ?? {}),
    ...(capabilities?.unavailable ?? {}),
  });
  const merged = new Map([...structural, ...explicit]);
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capability, reason]) => ({
      code: "degraded_capability" as const,
      message: `Capability '${capability}' is not fully available: ${reason}`,
    }));
}

/** Deterministically segment visible trace evidence; this function makes no provider or replayability proof claims. */
export function segmentTrace(
  input: readonly TraceEvent[] | SegmentationInput,
  metadata?: { capabilities?: CapabilityMetadata; lossiness?: LossinessMetadata },
): SegmentationResult {
  const configured: SegmentationInput =
    !Array.isArray(input) && typeof input === "object" && input !== null && "events" in input
      ? input
      : { events: input, ...metadata };
  const normalized = validateAndSortTraceEvents(configured.events);
  const causalityResult = buildCausality(normalized.events);
  const causalWarnings = validateCausalReferences(normalized.events).map((warning) => ({
    code: "invalid_causal_reference" as const,
    message: warning.message,
    eventId: warning.eventId,
    referencedEventId: warning.referencedEventId,
  }));
  const causalityWarnings = [...causalityResult.warnings, ...causalWarnings];
  const verificationResult = buildVerification(normalized.events);
  const warnings = [
    ...normalized.warnings,
    ...capabilityWarnings(configured.capabilities),
    ...causalityWarnings,
    ...verificationResult.warnings,
  ];
  for (const eventId of configured.lossiness?.redactedEventIds ?? [])
    warnings.push({
      code: "lossy_event",
      message: `Event '${eventId}' contains redacted content; extraction retains the lossiness boundary.`,
      eventId,
    });
  for (const eventId of Object.keys(configured.lossiness?.removedFields ?? {}).sort())
    warnings.push({
      code: "lossy_event",
      message: `Event '${eventId}' has removed fields; extraction retains the lossiness boundary.`,
      eventId,
    });
  const features = classifyFeatures(normalized.events);
  const candidateVariables = inferCandidateVariables(normalized.events);
  const goalEpisodes = buildGoalEpisodes(normalized.events, causalityResult.groups);
  const toolClusters = buildToolClusters(normalized.events);
  const failuresResult = buildFailures(normalized.events);
  const verification = verificationResult.segments;
  const groups: Array<{ kind: EvidenceKind; eventIds: readonly string[]; summary?: string }> = [
    ...goalEpisodes.map((episode) => ({
      kind: "goal_episode" as const,
      eventIds: episode.eventIds,
      summary: `Goal episode ${episode.key}.`,
    })),
    ...toolClusters.map((cluster) => ({
      kind: "tool_cluster" as const,
      eventIds: cluster.eventIds,
      summary: `Tool cluster: ${cluster.toolNames.join(", ") || "unlabelled"}.`,
    })),
    ...failuresResult.failures.map((failure) => ({
      kind: "failure" as const,
      eventIds: failure.eventIds,
      summary: `${failure.kind}${failure.resolved ? " with recovery" : " without observed recovery"}.`,
    })),
    ...failuresResult.recoveries.map((recovery) => ({
      kind: "recovery" as const,
      eventIds: recovery.eventIds,
      summary: "Observed recovery transition.",
    })),
    ...verification.map((check) => ({
      kind: "verification" as const,
      eventIds: check.eventIds,
      summary: `Verification${check.check ? `: ${check.check}` : ""}.`,
    })),
    ...features.map((feature) => ({
      kind: "feature" as const,
      eventIds: [feature.eventId],
      summary: `${feature.class}: ${feature.rationale}`,
    })),
    ...candidateVariables.map((variable) => ({
      kind: "variable" as const,
      eventIds: variable.eventIds,
      summary: `Candidate variable ${variable.name}.`,
    })),
  ];
  const evidence = createEvidenceReferences(normalized.events, groups);
  warnings.sort(
    (a, b) =>
      (a.eventId ?? a.referencedEventId ?? "").localeCompare(
        b.eventId ?? b.referencedEventId ?? "",
      ) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
  return {
    events: normalized.events,
    warnings,
    causality: causalityResult.groups,
    goalEpisodes,
    toolClusters,
    failures: failuresResult.failures,
    recoveries: failuresResult.recoveries,
    verification,
    features,
    candidateVariables,
    evidence: evidence.references,
    evidenceWarnings: evidence.warnings,
    metadata: {
      ...(configured.capabilities ? { capabilities: configured.capabilities } : {}),
      ...(configured.lossiness ? { lossiness: configured.lossiness } : {}),
    },
  };
}

export {
  createEvidenceReferences,
  stableEvidenceId,
  validateCausalReferences,
} from "./evidence.js";
export { classifyFeature, classifyFeatures, inferCandidateVariables } from "./features.js";
