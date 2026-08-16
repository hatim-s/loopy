import { createHash } from "node:crypto";
import type { ExtractionProposal, JsonObject, ProviderId, TraceEvent } from "@loopy/contracts";
import { TraceEventSchema } from "@loopy/contracts";
import { stableEvidenceId } from "./evidence.ts";
import type { DeterministicExtractionInput } from "./prompt.ts";
import type { ExtractorAgent, ExtractorAgentRequest } from "./proposal.ts";
import { type ExtractionRunResult, extractWithRepair, type RepairOptions } from "./repair.ts";
import type { CapabilityMetadata, LossinessMetadata, SegmentationResult } from "./segmentation.ts";
import { segmentTrace } from "./segmentation.ts";

export * from "./compiler.ts";
export * from "./evidence.ts";
export * from "./features.ts";
export * from "./prompt.ts";
export * from "./proposal.ts";
export * from "./repair.ts";
export * from "./segmentation.ts";

/** The storage-facing shape is deliberately structural to avoid a package cycle. */
export interface ImportedSessionForExtraction {
  id: string;
  provider: string;
  session: unknown;
  capabilities?: JsonObject;
  capabilityMetadata?: JsonObject;
  lossiness?: JsonObject;
  lossinessMetadata?: JsonObject;
}

export interface ExtractionAudit {
  version: "1";
  importId: string;
  provider: string;
  sourceEventCount: number;
  segmentCounts: Record<string, number>;
  warningCodes: string[];
  evidenceIds: string[];
  attempts: number;
  repairDiagnostics: readonly unknown[];
  review: DeterministicReview;
  deterministic: true;
}

export interface DeterministicReview {
  status: "ready" | "blocked";
  blockingQuestions: number;
  diagnostics: readonly string[];
}

export interface DeterministicExtraction {
  input: DeterministicExtractionInput;
  segmentation: SegmentationResult;
  result: ExtractionRunResult;
  audit: ExtractionAudit;
}

/** Review is a pure projection of the bounded extraction result; it has no provider side effects. */
export function reviewDeterministicExtraction(result: ExtractionRunResult): DeterministicReview {
  if (!result.ok) {
    return {
      status: "blocked",
      blockingQuestions: 0,
      diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }
  const blockingQuestions = result.proposal.unresolvedQuestions.filter(
    (question) => question.blocksExecution,
  ).length;
  return {
    status: blockingQuestions === 0 ? "ready" : "blocked",
    blockingQuestions,
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code),
  };
}

export const deterministicReview = reviewDeterministicExtraction;

function stableId(namespace: string, value: string): string {
  const bytes = createHash("sha256").update(`${namespace}\0${value}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceEvents(session: unknown): TraceEvent[] {
  if (!Array.isArray(session))
    throw new Error("Imported session must contain a canonical event array");
  const parsed = session.map((event) => TraceEventSchema.parse(event));
  if (parsed.length === 0) throw new Error("Imported session has no canonical events");
  return parsed;
}

function asCapabilities(value: JsonObject | undefined): CapabilityMetadata | undefined {
  return value ? (value as unknown as CapabilityMetadata) : undefined;
}

function asLossiness(value: JsonObject | undefined): LossinessMetadata | undefined {
  return value ? (value as unknown as LossinessMetadata) : undefined;
}

export function prepareDeterministicExtractionInput(imported: ImportedSessionForExtraction): {
  input: DeterministicExtractionInput;
  segmentation: SegmentationResult;
} {
  const events = sourceEvents(imported.session);
  const segmentation = segmentTrace({
    events,
    capabilities: asCapabilities(imported.capabilities ?? imported.capabilityMetadata),
    lossiness: asLossiness(imported.lossiness ?? imported.lossinessMetadata),
  });
  return {
    input: {
      importId: imported.id,
      sourceEvents: segmentation.events as unknown as JsonObject[],
      sourceEventIds: segmentation.events.map((event) => event.id),
      segments: [
        ...segmentation.goalEpisodes.map((item) => ({
          id: item.episodeId,
          eventIds: item.eventIds,
          kind: "goal_episode",
          key: item.key,
        })),
        ...segmentation.toolClusters.map((item) => ({
          id: item.clusterId,
          eventIds: item.eventIds,
          kind: "tool_cluster",
        })),
        ...segmentation.failures.map((item) => ({
          id: item.failureId,
          eventIds: item.eventIds,
          kind: item.kind,
        })),
      ],
      features: segmentation.features.map((item) => ({
        id: item.eventId,
        eventIds: [item.eventId],
        class: item.class,
        confidence: item.confidence,
      })),
      evidence: segmentation.evidence.map((item) => ({
        id: item.evidenceId,
        eventIds: item.eventIds,
        kind: item.kind,
        summary: item.summary,
      })),
    },
    segmentation,
  };
}

function firstEvidence(segmentation: SegmentationResult) {
  const first = segmentation.evidence[0];
  if (first) return first;
  const eventIds = segmentation.events.map((event) => event.id);
  return {
    evidenceId: stableEvidenceId("goal_episode", eventIds),
    eventIds,
    kind: "goal_episode" as const,
    firstSequence: 0,
    lastSequence: segmentation.events.length - 1,
    summary: "Imported canonical session evidence.",
  };
}

const SUPPORTED_PROVIDERS = new Set<ProviderId>(["codex", "claude", "opencode", "pi"]);

/** Reject invalid provider selection; never silently substitute a different provider. */
function providerId(provider: string): ProviderId {
  if (SUPPORTED_PROVIDERS.has(provider as ProviderId)) return provider as ProviderId;
  throw new RangeError(
    `Unsupported extraction provider '${provider}'. Expected codex, claude, opencode, or pi.`,
  );
}

function eventPayload(event: TraceEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Trace-derived steps are intentionally limited to read-only, known tool
// vocabulary. Unknown tools remain evidence and require human clarification;
// they are never copied into a runnable workflow.
const SUPPORTED_READONLY_TOOLS = new Set(["cat", "find", "ls", "pwd", "git status", "git diff"]);
const CANONICAL_VERIFIERS = new Map([
  ["test", { check: "tests", command: "bun", args: ["test"] }],
  ["tests", { check: "tests", command: "bun", args: ["test"] }],
  ["lint", { check: "lint", command: "bun", args: ["run", "lint"] }],
  ["typecheck", { check: "typecheck", command: "bun", args: ["run", "typecheck"] }],
]);

interface TraceIntent {
  event: TraceEvent;
  evidenceId: string;
  eventIds: string[];
  prompt: string;
}

interface CanonicalVerifier {
  check: string;
  command: string;
  args: string[];
  evidenceId: string;
  eventIds: string[];
}

function evidenceForEvent(
  segmentation: SegmentationResult,
  eventId: string,
  kind?: string,
): (typeof segmentation.evidence)[number] | undefined {
  return segmentation.evidence.find(
    (evidence) =>
      (!kind || evidence.kind === kind) &&
      evidence.eventIds.length === 1 &&
      evidence.eventIds[0] === eventId,
  );
}

function readOnlyIntents(segmentation: SegmentationResult): TraceIntent[] {
  return segmentation.events.flatMap((event) => {
    if (event.type !== "tool.requested") return [];
    const payload = eventPayload(event);
    const tool = text(payload.tool)?.toLowerCase();
    if (!tool || !SUPPORTED_READONLY_TOOLS.has(tool)) return [];
    const evidence = evidenceForEvent(segmentation, event.id, "feature");
    if (!evidence) return [];
    return [
      {
        event,
        evidenceId: evidence.evidenceId,
        eventIds: evidence.eventIds,
        prompt: [
          `Perform only the observed read-only intent from source event ${event.id}.`,
          `Observed tool: ${tool}.`,
          `Observed input: ${JSON.stringify(payload.input ?? null)}.`,
          "Do not write files, contact external systems, or perform any other operation.",
        ].join(" "),
      },
    ];
  });
}

function canonicalVerifiers(segmentation: SegmentationResult): {
  verifiers: CanonicalVerifier[];
  unsupportedChecks: string[];
} {
  const unsupportedChecks: string[] = [];
  const verifiers: CanonicalVerifier[] = [];
  for (const verification of segmentation.verification) {
    const check = text(verification.check)?.toLowerCase();
    const canonical = check ? CANONICAL_VERIFIERS.get(check) : undefined;
    const evidence = segmentation.evidence.find(
      (item) =>
        item.kind === "verification" &&
        item.eventIds.join("\0") === verification.eventIds.join("\0"),
    );
    if (!canonical || !evidence) {
      unsupportedChecks.push(check ?? "opaque verification");
      continue;
    }
    const observedCommands = segmentation.events
      .filter((event) => verification.eventIds.includes(event.id))
      .flatMap((event) => {
        const command = text(eventPayload(event).command);
        return command ? [command.toLowerCase()] : [];
      });
    const canonicalLine = [canonical.command, ...canonical.args].join(" ");
    if (observedCommands.some((command) => command !== canonicalLine)) {
      unsupportedChecks.push(`${check} (non-canonical command)`);
      continue;
    }
    verifiers.push({ ...canonical, evidenceId: evidence.evidenceId, eventIds: evidence.eventIds });
  }
  return { verifiers, unsupportedChecks };
}

function traceBlockers(
  segmentation: SegmentationResult,
  intents: readonly TraceIntent[],
  unsupportedChecks: readonly string[],
): string[] {
  const blockers: string[] = [];
  const requestedToolCalls = new Set(
    segmentation.events
      .filter((event) => event.type === "tool.requested")
      .map((event) => event.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const event of segmentation.events) {
    const payload = eventPayload(event);
    if (event.redaction.status !== "none") blockers.push(`redacted event ${event.id}`);
    if (event.type === "tool.requested") {
      const tool = text(payload.tool)?.toLowerCase();
      if (!tool || !SUPPORTED_READONLY_TOOLS.has(tool))
        blockers.push(`unsupported tool '${tool ?? "opaque"}'`);
    }
    if (event.type === "tool.started" && !requestedToolCalls.has(event.toolCallId))
      blockers.push(`opaque tool start ${event.id}`);
    if (event.type === "tool.denied")
      blockers.push(`denied tool ${text(payload.tool) ?? "opaque"}`);
    if (event.type === "provider.message" && payload.role === "user")
      blockers.push(`opaque provider instruction ${event.id}`);
  }
  for (const feature of segmentation.features)
    if (feature.class === "side_effect") blockers.push(feature.rationale);
  for (const check of unsupportedChecks) blockers.push(`unsupported verification '${check}'`);
  if (intents.length === 0) blockers.push("no supported read-only source intent was observed");
  if (segmentation.verification.length === 0)
    blockers.push("no supported canonical verification event was observed");
  return [...new Set(blockers)];
}

interface VariableEvidenceMatch {
  evidenceIds: string[];
  missingEventIds: string[];
}

/**
 * Match inferred variables only to deterministic variable evidence. Evidence
 * with events outside the candidate set cannot ground that candidate, even if
 * it happens to contain one of its source events (for example, a goal episode
 * or the first intent evidence).
 */
function variableEvidenceMatch(
  segmentation: SegmentationResult,
  eventIds: readonly string[],
): VariableEvidenceMatch {
  const sourceEventIds = [...new Set(eventIds)];
  const sourceEventSet = new Set(sourceEventIds);
  const matches = segmentation.evidence.filter(
    (evidence) =>
      evidence.kind === "variable" &&
      evidence.eventIds.length > 0 &&
      evidence.eventIds.every((eventId) => sourceEventSet.has(eventId)),
  );
  const coveredEventIds = new Set(matches.flatMap((evidence) => evidence.eventIds));
  return {
    evidenceIds: matches.map((evidence) => evidence.evidenceId),
    missingEventIds: sourceEventIds.filter((eventId) => !coveredEventIds.has(eventId)),
  };
}

function proposalFromEvidence(
  request: ExtractorAgentRequest,
  segmentation: SegmentationResult,
  provider: string,
): ExtractionProposal {
  const primary = firstEvidence(segmentation);
  const intents = readOnlyIntents(segmentation);
  const verifierResult = canonicalVerifiers(segmentation);
  const variableGroundings = segmentation.candidateVariables.map((variable) => ({
    variable,
    match: variableEvidenceMatch(segmentation, variable.eventIds),
  }));
  const variableBlockers = variableGroundings
    .filter(({ match }) => match.missingEventIds.length > 0)
    .map(
      ({ variable, match }) =>
        `candidate variable '${variable.name}' has no prepared evidence covering source event(s): ${match.missingEventIds.join(", ")}`,
    );
  const blockers = [
    ...traceBlockers(segmentation, intents, verifierResult.unsupportedChecks),
    ...variableBlockers,
  ];
  const workflowId = stableId("workflow", request.importId);
  const createdAt = segmentation.events[0]?.occurredAt ?? "2026-01-01T00:00:00.000Z";
  const agentNodes = intents.map((intent, index) => ({
    id: stableId("workflow-node", `${request.importId}:agent:${index}:${intent.event.id}`),
    name: `Read observed ${text(eventPayload(intent.event).tool) ?? "repository"}`,
    kind: "agent" as const,
    prompt: intent.prompt,
    provider: providerId(provider),
    skills: [],
    inputBindings: {},
    requiredCapabilities: [],
    completionContract: "node_completion" as const,
    tags: ["extracted", "read-only", "trace-derived"],
  }));
  const verifyNodes = verifierResult.verifiers.length
    ? [
        {
          id: stableId("workflow-node", `${request.importId}:verify`),
          name: "Verify extracted workflow",
          kind: "verify" as const,
          description: `Run only canonical checks observed in the trace: ${verifierResult.verifiers
            .map((item) => item.check)
            .join(", ")}.`,
          commands: verifierResult.verifiers.map(({ command, args }) => ({
            command,
            args,
            timeoutMs: 120_000,
          })),
          success: "all" as const,
          expectedExitCode: 0,
          tags: ["extracted", "verification", "trace-derived"],
        },
      ]
    : [];
  const intentEvidenceIds = new Set(intents.map((intent) => intent.evidenceId));
  const verifierEvidenceIds = new Set(
    verifierResult.verifiers.map((verifier) => verifier.evidenceId),
  );
  const canGroundApproval = segmentation.evidence.some(
    (evidence) =>
      !intentEvidenceIds.has(evidence.evidenceId) && !verifierEvidenceIds.has(evidence.evidenceId),
  );
  const approvalNodes =
    blockers.length && canGroundApproval
      ? [
          {
            id: stableId("workflow-node", `${request.importId}:approval`),
            name: "Review unsupported trace work",
            kind: "approval" as const,
            message: `Review before execution: ${blockers.join("; ")}.`,
            approvalKey: stableId("approval", request.importId),
            tags: ["extracted", "approval", "trace-boundary"],
          },
        ]
      : [];
  const nodes = [...approvalNodes, ...agentNodes, ...verifyNodes];
  const workflowNodeIds = nodes.map((node) => node.id);
  const edges = workflowNodeIds.slice(1).map((target, index) => ({
    id: stableId("workflow-edge", `${workflowNodeIds[index]}:${target}`),
    source: workflowNodeIds[index] as string,
    target,
    metadata: {},
  }));
  const variables = variableGroundings
    .map(({ variable, match }) => {
      if (match.missingEventIds.length > 0 || match.evidenceIds.length === 0) return undefined;
      return {
        name: variable.name,
        type: variable.type,
        description: variable.rationale,
        required: false,
        example: variable.observedValues[0],
        observedValues: variable.observedValues,
        confidence: variable.confidence,
        evidenceIds: match.evidenceIds,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const agentEvidence = intents.map((intent, index) => ({
    evidenceId: intent.evidenceId,
    nodeId: agentNodes[index]?.id as string,
    eventIds: intent.eventIds,
    rationale: `The read-only agent prompt is grounded in source event ${intent.event.id}.`,
  }));
  const verifyEvidence = verifierResult.verifiers.map((verifier) => ({
    evidenceId: verifier.evidenceId,
    nodeId: verifyNodes[0]?.id as string,
    eventIds: verifier.eventIds,
    rationale: `The ${verifier.check} verifier is grounded in canonical verification events.`,
  }));
  const variableEvidenceNodeId = agentNodes[0]?.id ?? verifyNodes[0]?.id ?? approvalNodes[0]?.id;
  const variableNodeEvidence = variableEvidenceNodeId
    ? variables
        .flatMap((variable) =>
          variable.evidenceIds.map((evidenceId) => {
            const evidence = segmentation.evidence.find((item) => item.evidenceId === evidenceId);
            if (!evidence) return undefined;
            return {
              evidenceId,
              nodeId: variableEvidenceNodeId,
              eventIds: evidence.eventIds,
              rationale: `The inferred input '${variable.name}' is grounded in deterministic variable evidence.`,
            };
          }),
        )
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .filter(
          (item, index, all) =>
            all.findIndex((candidate) => candidate.evidenceId === item.evidenceId) === index,
        )
    : [];
  const usedEvidenceIds = new Set(
    [...agentEvidence, ...verifyEvidence, ...variableNodeEvidence].map((item) => item.evidenceId),
  );
  const approvalSource = segmentation.evidence.find(
    (evidence) => !usedEvidenceIds.has(evidence.evidenceId),
  );
  const approvalEvidence =
    blockers.length && approvalNodes[0] && approvalSource
      ? [
          {
            evidenceId: approvalSource.evidenceId,
            nodeId: approvalNodes[0].id,
            eventIds: approvalSource.eventIds,
            rationale: "The review barrier is grounded in imported trace evidence.",
          },
        ]
      : [];
  const nodeEvidence = [
    ...approvalEvidence,
    ...agentEvidence,
    ...verifyEvidence,
    ...variableNodeEvidence,
  ];
  const evidenceAnchor = nodeEvidence[0]?.evidenceId ?? primary.evidenceId;
  const verifierEvidenceId = verifierResult.verifiers[0]?.evidenceId ?? evidenceAnchor;
  const workflow = {
    schemaVersion: "1" as const,
    workflowVersion: 1,
    id: workflowId,
    name: `Extracted workflow ${request.importId.slice(0, 8)}`,
    description: "Deterministic draft compiled from observed canonical trace evidence.",
    inputs: variables.map(
      ({
        observedValues: _observed,
        confidence: _confidence,
        evidenceIds: _evidence,
        ...input
      }) => ({
        ...input,
        secret: false,
      }),
    ),
    nodes,
    edges,
    defaults: {
      provider: providerId(provider),
      timeoutMs: 3_600_000,
      retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    },
    policies: {
      tools: { allow: [], deny: [], network: "disabled" as const },
      workspace: { writableRoots: [], useGitWorktree: true, allowDirtyWorkspace: false },
      approval: {
        requiredBefore: blockers.length ? (["agent", "verify"] as const) : [],
        sideEffectLabels: segmentation.features
          .filter((feature) => feature.class === "side_effect")
          .map((feature) => feature.rationale),
      },
      budget: { timeoutMs: 3_600_000 },
      concurrency: { maxParallel: 1 },
    },
    triggers: { manual: true },
    metadata: {
      createdAt,
      updatedAt: createdAt,
      createdFrom: "extraction" as const,
      tags: ["deterministic", "phase3"],
    },
  };
  return {
    schemaVersion: "1",
    id: stableId("proposal", request.importId),
    importId: request.importId,
    createdAt,
    workflow,
    inferredInputs: variables,
    nodeEvidence,
    removedDetours: segmentation.failures.map((failure) => ({
      description: `${failure.kind} observed during the source run`,
      reason: failure.resolved
        ? "Recovered in the source run; omit from reusable work."
        : "Unresolved source failure.",
      eventIds: failure.eventIds,
    })),
    warnings: segmentation.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      severity:
        warning.code === "invalid_causal_reference" ? ("error" as const) : ("warning" as const),
      source: "deterministic-segmentation",
    })),
    verifierRequirements: verifierResult.verifiers.length
      ? verifierResult.verifiers.map((verifier) => ({
          check: verifier.check,
          command: [verifier.command, ...verifier.args].join(" "),
          rationale: `The ${verifier.check} check was observed as a canonical verification event.`,
          evidenceIds: [verifier.evidenceId],
          required: true,
        }))
      : [
          {
            check: "verification unavailable",
            rationale: "No allowlisted canonical verification event was observed in the trace.",
            evidenceIds: [verifierEvidenceId],
            required: true,
          },
        ],
    proposedPolicies: {
      tools: { allow: [], deny: [], network: "disabled" as const },
      workspace: { writableRoots: [], useGitWorktree: true, allowDirtyWorkspace: false },
      approval: {
        requiredBefore: blockers.length ? (["agent", "verify"] as const) : [],
        sideEffectLabels: segmentation.features
          .filter((feature) => feature.class === "side_effect")
          .map((feature) => feature.rationale),
      },
      budget: { timeoutMs: 3_600_000 },
      concurrency: { maxParallel: 1 },
      evidenceIds: [evidenceAnchor],
    },
    expectedSideEffects: segmentation.features
      .filter((feature) => feature.class === "side_effect")
      .map((feature) => feature.rationale),
    unresolvedQuestions: blockers.map((blocker) => ({
      question: `How should this trace boundary be handled safely: ${blocker}?`,
      blocksExecution: true,
    })),
    status: "draft",
  } as unknown as ExtractionProposal;
}

export interface DeterministicAgentOptions {
  provider?: string;
  failFirstWith?: unknown;
}

/** A local, provider-neutral fake extractor used by the CLI and offline tests. */
export function createDeterministicExtractorAgent(
  segmentation: SegmentationResult,
  options: DeterministicAgentOptions = {},
): ExtractorAgent {
  let first = true;
  return {
    extract(request) {
      if (first && options.failFirstWith !== undefined) {
        first = false;
        return options.failFirstWith;
      }
      first = false;
      return proposalFromEvidence(request, segmentation, options.provider ?? "codex");
    },
  };
}

export async function extractImportedSession(
  imported: ImportedSessionForExtraction,
  options: RepairOptions & DeterministicAgentOptions = {},
): Promise<DeterministicExtraction> {
  const prepared = prepareDeterministicExtractionInput(imported);
  const result = await extractWithRepair(
    prepared.input,
    createDeterministicExtractorAgent(prepared.segmentation, options),
    options,
  );
  return {
    ...prepared,
    result,
    audit: {
      version: "1",
      importId: imported.id,
      provider: imported.provider,
      sourceEventCount: prepared.segmentation.events.length,
      segmentCounts: {
        causality: prepared.segmentation.causality.length,
        goals: prepared.segmentation.goalEpisodes.length,
        tools: prepared.segmentation.toolClusters.length,
        failures: prepared.segmentation.failures.length,
        recoveries: prepared.segmentation.recoveries.length,
        verification: prepared.segmentation.verification.length,
        features: prepared.segmentation.features.length,
        variables: prepared.segmentation.candidateVariables.length,
        evidence: prepared.segmentation.evidence.length,
      },
      warningCodes: prepared.segmentation.warnings.map((warning) => warning.code),
      evidenceIds: prepared.segmentation.evidence.map((evidence) => evidence.evidenceId),
      attempts: result.attempts,
      repairDiagnostics: result.audits.flatMap((attempt) => attempt.diagnostics),
      review: reviewDeterministicExtraction(result),
      deterministic: true,
    },
  };
}

export const runDeterministicExtraction = extractImportedSession;
