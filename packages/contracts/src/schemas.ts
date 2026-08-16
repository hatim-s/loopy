import { z } from "zod";

/**
 * Persisted contracts are versioned deliberately. Keep the current aliases
 * below for ergonomics, but make the versioned schemas the source of truth so
 * a future migration can add a second branch without rewriting every caller.
 */
export const SCHEMA_VERSION_V1 = "1" as const;
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION_V1;
export const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
export const SUPPORTED_SCHEMA_VERSIONS = [SCHEMA_VERSION_V1] as const;
export const SchemaVersionV1Schema = z.literal(SCHEMA_VERSION_V1);
export const SupportedSchemaVersionSchema = z.enum(SUPPORTED_SCHEMA_VERSIONS);
/** Current-version alias retained for existing callers. */
export const SchemaVersionSchema = SupportedSchemaVersionSchema;
export type SchemaVersionV1 = z.infer<typeof SchemaVersionV1Schema>;
export type SchemaVersion = z.infer<typeof SupportedSchemaVersionSchema>;

export const StableIdSchema = z.uuid();
export type StableId = z.infer<typeof StableIdSchema>;
export const NonEmptyStringSchema = z.string().trim().min(1);
export const TimestampSchema = z.string().datetime({ offset: true });

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const ProviderIdSchema = z.enum(["codex", "claude", "opencode", "pi"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export const ReasoningLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** Capabilities are intentionally closed: runtimes can reason about these names. */
export const CapabilitySchema = z.enum([
  "structuredStreamingEvents",
  "historicalSessionImport",
  "sessionResume",
  "sessionFork",
  "explicitModelSelection",
  "explicitReasoningLevel",
  "toolAllowlist",
  "writablePathPolicy",
  "networkPolicy",
  "maxTurns",
  "tokenBudget",
  "monetaryBudget",
  "timeoutCancellation",
  "usageReporting",
  "nestedSubagentVisibility",
  "nativeSandbox",
]);
export type Capability = z.infer<typeof CapabilitySchema>;
export const CapabilityRequirementLevelSchema = z.enum(["required", "advisory"]);
export type CapabilityRequirementLevel = z.infer<typeof CapabilityRequirementLevelSchema>;
export const CapabilityRequirementSchema = z.object({
  capability: CapabilitySchema,
  level: CapabilityRequirementLevelSchema.default("required"),
});
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;

/**
 * Dataflow is deliberately a small value-reference algebra. Arbitrary
 * expression strings are not persisted because their evaluation semantics
 * cannot be made portable between providers and runtimes.
 */
export const ValueReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: JsonValueSchema }),
  z.object({ kind: z.literal("workflow_input"), name: NonEmptyStringSchema }),
  z.object({
    kind: z.literal("node_output"),
    nodeId: StableIdSchema,
    path: z.array(NonEmptyStringSchema).default([]),
  }),
]);
export type ValueReference = z.infer<typeof ValueReferenceSchema>;

export const WorkflowInputTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "json",
  "path",
  "directory",
]);
export const WorkflowInputSchema = z.object({
  name: NonEmptyStringSchema,
  type: WorkflowInputTypeSchema,
  description: z.string().trim().optional(),
  required: z.boolean().default(true),
  default: JsonValueSchema.optional(),
  secret: z.boolean().default(false),
  example: JsonValueSchema.optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(1),
  backoffMs: z.number().int().min(0).max(86_400_000).default(0),
  retryOn: z
    .array(z.enum(["provider_error", "timeout", "verification_failed", "cancelled"]))
    .default([]),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const ToolPolicySchema = z.object({
  allow: z.array(NonEmptyStringSchema).default([]),
  deny: z.array(NonEmptyStringSchema).default([]),
  network: z.enum(["disabled", "restricted", "unrestricted"]).default("disabled"),
});
export const WorkspacePolicySchema = z.object({
  workingDirectory: z.string().trim().min(1).optional(),
  writableRoots: z.array(z.string().trim().min(1)).default([]),
  useGitWorktree: z.boolean().default(true),
  allowDirtyWorkspace: z.boolean().default(false),
});
export const ApprovalPolicySchema = z.object({
  requiredBefore: z.array(z.enum(["agent", "verify", "transform"])).default([]),
  sideEffectLabels: z.array(NonEmptyStringSchema).default([]),
});
export const BudgetPolicySchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().default(3_600_000),
});
export const ConcurrencyPolicySchema = z.object({
  maxParallel: z.number().int().positive().max(64).default(1),
});
export const WorkflowPolicySchema = z.object({
  tools: ToolPolicySchema.default({ allow: [], deny: [], network: "disabled" }),
  workspace: WorkspacePolicySchema.default({
    writableRoots: [],
    useGitWorktree: true,
    allowDirtyWorkspace: false,
  }),
  approval: ApprovalPolicySchema.default({ requiredBefore: [], sideEffectLabels: [] }),
  budget: BudgetPolicySchema.default({ timeoutMs: 3_600_000 }),
  concurrency: ConcurrencyPolicySchema.default({ maxParallel: 1 }),
});
export type WorkflowPolicy = z.infer<typeof WorkflowPolicySchema>;

export const ProviderDefaultsSchema = z.object({
  provider: ProviderIdSchema,
  model: NonEmptyStringSchema.optional(),
  reasoning: ReasoningLevelSchema.optional(),
  timeoutMs: z.number().int().positive().default(3_600_000),
  retry: RetryPolicySchema.default({ maxAttempts: 1, backoffMs: 0, retryOn: [] }),
});
export type ProviderDefaults = z.infer<typeof ProviderDefaultsSchema>;

const NodeBaseSchema = z.object({
  id: StableIdSchema,
  name: NonEmptyStringSchema,
  description: z.string().trim().optional(),
  tags: z.array(NonEmptyStringSchema).default([]),
});

export const AgentNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("agent"),
  prompt: NonEmptyStringSchema,
  provider: ProviderIdSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  reasoning: ReasoningLevelSchema.optional(),
  skills: z.array(NonEmptyStringSchema).default([]),
  inputBindings: z.record(z.string(), ValueReferenceSchema).default({}),
  requiredCapabilities: z.array(CapabilityRequirementSchema).default([]),
  completionContract: z.enum(["node_completion", "json"]).default("node_completion"),
});
export const VerifyCommandSchema = z.object({
  command: NonEmptyStringSchema,
  args: z.array(z.string()).default([]),
  cwd: z.string().trim().optional(),
  timeoutMs: z.number().int().positive().default(120_000),
});
export const VerifyNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("verify"),
  commands: z.array(VerifyCommandSchema).min(1),
  success: z.enum(["all", "any"]).default("all"),
  expectedExitCode: z.number().int().default(0),
});
export const ApprovalNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("approval"),
  message: NonEmptyStringSchema,
  approvalKey: NonEmptyStringSchema,
  expiresAfterMs: z.number().int().positive().optional(),
});
export const RouteNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("route"),
  expression: NonEmptyStringSchema,
  defaultRoute: NonEmptyStringSchema.optional(),
});
export const JoinNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("join"),
  policy: z.enum(["all", "any", "quorum"]).default("all"),
  quorum: z.number().int().positive().optional(),
  outputMode: z.enum(["array", "object", "first_success"]).default("array"),
});
export const TransformNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("transform"),
  operation: z.enum(["pick", "merge", "template"]),
  mapping: z.record(z.string(), ValueReferenceSchema).default({}),
});

export const NodeSchema = z.discriminatedUnion("kind", [
  AgentNodeSchema,
  VerifyNodeSchema,
  ApprovalNodeSchema,
  RouteNodeSchema,
  JoinNodeSchema,
  TransformNodeSchema,
]);
export type AgentNode = z.infer<typeof AgentNodeSchema>;
export type VerifyNode = z.infer<typeof VerifyNodeSchema>;
export type ApprovalNode = z.infer<typeof ApprovalNodeSchema>;
export type RouteNode = z.infer<typeof RouteNodeSchema>;
export type JoinNode = z.infer<typeof JoinNodeSchema>;
export type TransformNode = z.infer<typeof TransformNodeSchema>;
export type WorkflowNode = z.infer<typeof NodeSchema>;

export const WorkflowEdgeSchema = z.object({
  id: StableIdSchema,
  source: StableIdSchema,
  target: StableIdSchema,
  label: NonEmptyStringSchema.optional(),
  condition: NonEmptyStringSchema.optional(),
  metadata: JsonObjectSchema.default({}),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowDefinitionV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  workflowVersion: z.number().int().positive(),
  id: StableIdSchema,
  name: NonEmptyStringSchema,
  description: z.string().trim().optional(),
  inputs: z.array(WorkflowInputSchema).default([]),
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(WorkflowEdgeSchema).default([]),
  defaults: ProviderDefaultsSchema,
  policies: WorkflowPolicySchema.default({
    tools: { allow: [], deny: [], network: "disabled" },
    workspace: { writableRoots: [], useGitWorktree: true, allowDirtyWorkspace: false },
    approval: { requiredBefore: [], sideEffectLabels: [] },
    budget: { timeoutMs: 3_600_000 },
    concurrency: { maxParallel: 1 },
  }),
  // Scheduling semantics (timezone, missed runs, overlap) are intentionally
  // deferred to Phase 6; v1 only persists an explicit manual trigger.
  triggers: z
    .object({ manual: z.boolean().default(true) })
    .strict()
    .default({ manual: true }),
  metadata: z.object({
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    createdFrom: z.enum(["manual", "extraction", "import"]).default("manual"),
    extractionId: StableIdSchema.optional(),
    tags: z.array(NonEmptyStringSchema).default([]),
  }),
});
export const WorkflowDefinitionSchema = WorkflowDefinitionV1Schema;
export const SupportedWorkflowDefinitionSchema = z.discriminatedUnion("schemaVersion", [
  WorkflowDefinitionV1Schema,
]);
export const WorkflowDefinitionByVersionSchema = SupportedWorkflowDefinitionSchema;
export type WorkflowDefinitionV1 = z.infer<typeof WorkflowDefinitionV1Schema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionV1Schema>;

export const ProviderCapabilitiesV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  provider: ProviderIdSchema,
  structuredStreamingEvents: z.boolean(),
  historicalSessionImport: z.boolean(),
  sessionResume: z.boolean(),
  sessionFork: z.boolean(),
  explicitModelSelection: z.boolean(),
  explicitReasoningLevel: z.boolean(),
  toolAllowlist: z.boolean(),
  writablePathPolicy: z.boolean(),
  networkPolicy: z.boolean(),
  maxTurns: z.boolean(),
  tokenBudget: z.boolean(),
  monetaryBudget: z.boolean(),
  timeoutCancellation: z.boolean(),
  usageReporting: z.boolean(),
  nestedSubagentVisibility: z.boolean(),
  nativeSandbox: z.boolean(),
  maxContextTokens: z.number().int().positive().optional(),
  notes: z.array(NonEmptyStringSchema).default([]),
});
export const ProviderCapabilitiesSchema = ProviderCapabilitiesV1Schema;
export const SupportedProviderCapabilitiesSchema = z.discriminatedUnion("schemaVersion", [
  ProviderCapabilitiesV1Schema,
]);
export const ProviderCapabilitiesByVersionSchema = SupportedProviderCapabilitiesSchema;
export type ProviderCapabilitiesV1 = z.infer<typeof ProviderCapabilitiesV1Schema>;
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesV1Schema>;

export const ProviderInstallationV1Schema = z
  .object({
    schemaVersion: SchemaVersionV1Schema,
    provider: ProviderIdSchema,
    installed: z.boolean(),
    executable: z.string().trim().optional(),
    version: z.string().trim().optional(),
    path: z.string().trim().optional(),
    detectedAt: TimestampSchema,
    capabilities: ProviderCapabilitiesSchema,
    diagnostic: z.string().trim().optional(),
  })
  .superRefine((installation, ctx) => {
    if (installation.capabilities.provider !== installation.provider) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "provider"],
        message: "Provider capabilities must describe the installed provider.",
      });
    }
  });
export const ProviderInstallationSchema = ProviderInstallationV1Schema;
export const SupportedProviderInstallationSchema = z.discriminatedUnion("schemaVersion", [
  ProviderInstallationV1Schema,
]);
export const ProviderInstallationByVersionSchema = SupportedProviderInstallationSchema;
export type ProviderInstallationV1 = z.infer<typeof ProviderInstallationV1Schema>;
export type ProviderInstallation = z.infer<typeof ProviderInstallationV1Schema>;

export const ProviderSessionRefSchema = z.object({
  provider: ProviderIdSchema,
  sessionId: NonEmptyStringSchema,
  parentSessionId: NonEmptyStringSchema.optional(),
});
export const ArtifactRefSchema = z.object({
  id: StableIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: NonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  producerNodeId: StableIdSchema.optional(),
  sourcePath: z.string().trim().optional(),
  redacted: z.boolean().default(false),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export const UsageRecordSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export const VerificationResultSchema = z.object({
  check: NonEmptyStringSchema,
  status: z.enum(["passed", "failed", "skipped"]),
  summary: NonEmptyStringSchema,
  command: z.string().trim().optional(),
  details: JsonObjectSchema.default({}),
  durationMs: z.number().int().nonnegative().optional(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export const ContractWarningSchema = z.object({
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  severity: z.enum(["info", "warning", "error"]),
  source: z.string().trim().optional(),
});
export type ContractWarning = z.infer<typeof ContractWarningSchema>;
export const NodeCompletionV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  status: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
  route: NonEmptyStringSchema.optional(),
  summary: z.string(),
  outputs: JsonObjectSchema.default({}),
  artifacts: z.array(ArtifactRefSchema).default([]),
  verification: z.array(VerificationResultSchema).default([]),
  providerSession: ProviderSessionRefSchema.optional(),
  usage: UsageRecordSchema.optional(),
  warnings: z.array(ContractWarningSchema).default([]),
});
export const NodeCompletionSchema = NodeCompletionV1Schema;
export const SupportedNodeCompletionSchema = z.discriminatedUnion("schemaVersion", [
  NodeCompletionV1Schema,
]);
export const NodeCompletionByVersionSchema = SupportedNodeCompletionSchema;
export type NodeCompletionV1 = z.infer<typeof NodeCompletionV1Schema>;
export type NodeCompletion = z.infer<typeof NodeCompletionV1Schema>;

const TraceEventBaseSchema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  id: StableIdSchema,
  runId: StableIdSchema,
  nodeId: StableIdSchema.optional(),
  attemptId: StableIdSchema.optional(),
  sequence: z.number().int().nonnegative(),
  occurredAt: TimestampSchema,
  monotonicOffsetMs: z.number().nonnegative(),
  provider: ProviderIdSchema.optional(),
  /** Provider session and tool call attribution live in the envelope. */
  sessionId: NonEmptyStringSchema.optional(),
  callId: StableIdSchema.optional(),
  parentEventId: StableIdSchema.optional(),
  redaction: z
    .object({
      status: z.enum(["none", "partial", "full"]),
      removedFields: z.array(NonEmptyStringSchema).default([]),
    })
    .default({ status: "none", removedFields: [] }),
});
const traceEvent = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  TraceEventBaseSchema.extend({ type: z.literal(type), payload });
const traceEventWithAttribution = <
  T extends string,
  P extends z.ZodTypeAny,
  A extends z.ZodRawShape,
>(
  type: T,
  payload: P,
  attribution: A,
) => traceEvent(type, payload).extend(attribution);

const RunCreatedEventSchema = traceEvent(
  "run.created",
  z.object({ workflowId: StableIdSchema, workflowVersion: z.number().int().positive() }),
);
const RunStartedEventSchema = traceEvent(
  "run.started",
  z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/) }),
);
const RunPauseRequestedEventSchema = traceEvent(
  "run.pause_requested",
  z.object({ requestedBy: z.enum(["user", "runtime"]) }),
);
const RunPausedEventSchema = traceEvent(
  "run.paused",
  z.object({ activeNodeIds: z.array(StableIdSchema).default([]) }),
);
const RunResumedEventSchema = traceEvent(
  "run.resumed",
  z.object({ resumedBy: z.enum(["user", "recovery"]) }),
);
const RunCancellingEventSchema = traceEvent(
  "run.cancelling",
  z.object({ reason: NonEmptyStringSchema }),
);
const RunCompletedEventSchema = traceEvent(
  "run.completed",
  z.object({ status: z.enum(["succeeded", "failed", "cancelled"]), summary: z.string() }),
);
const NodeReadyEventSchema = traceEventWithAttribution("node.ready", z.object({}).strict(), {
  nodeId: StableIdSchema,
});
const NodeStartedEventSchema = traceEventWithAttribution("node.started", z.object({}).strict(), {
  nodeId: StableIdSchema,
  attemptId: StableIdSchema,
});
const NodeOutputEventSchema = traceEventWithAttribution(
  "node.output",
  z.object({ output: JsonObjectSchema }).strict(),
  { nodeId: StableIdSchema },
);
const NodeBlockedEventSchema = traceEventWithAttribution(
  "node.blocked",
  z.object({ reason: NonEmptyStringSchema }).strict(),
  { nodeId: StableIdSchema },
);
const NodeCompletedEventSchema = traceEventWithAttribution(
  "node.completed",
  z.object({ completion: NodeCompletionSchema }).strict(),
  { nodeId: StableIdSchema },
);
const AttemptCreatedEventSchema = traceEventWithAttribution(
  "attempt.created",
  z.object({ attempt: z.number().int().positive() }).strict(),
  { nodeId: StableIdSchema, attemptId: StableIdSchema },
);
const AttemptRetryingEventSchema = traceEventWithAttribution(
  "attempt.retrying",
  z.object({ nextAttempt: z.number().int().positive(), reason: NonEmptyStringSchema }).strict(),
  { nodeId: StableIdSchema, attemptId: StableIdSchema },
);
const AttemptFailedEventSchema = traceEventWithAttribution(
  "attempt.failed",
  z.object({ error: NonEmptyStringSchema }).strict(),
  { nodeId: StableIdSchema, attemptId: StableIdSchema },
);
const AttemptCancelledEventSchema = traceEventWithAttribution(
  "attempt.cancelled",
  z.object({ reason: NonEmptyStringSchema }).strict(),
  { nodeId: StableIdSchema, attemptId: StableIdSchema },
);
const ProviderProbedEventSchema = traceEventWithAttribution(
  "provider.probed",
  z.object({ installation: ProviderInstallationSchema }).strict(),
  { provider: ProviderIdSchema },
).superRefine((event, ctx) => {
  if (event.provider !== event.payload.installation.provider) {
    ctx.addIssue({
      code: "custom",
      path: ["payload", "installation", "provider"],
      message: "Trace provider attribution must match the probed installation.",
    });
  }
});
const ProviderSessionStartedEventSchema = traceEventWithAttribution(
  "provider.session_started",
  z.object({ parentSessionId: NonEmptyStringSchema.optional() }),
  { provider: ProviderIdSchema, sessionId: NonEmptyStringSchema },
);
const ProviderMessageEventSchema = traceEventWithAttribution(
  "provider.message",
  z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() }),
  { provider: ProviderIdSchema, sessionId: NonEmptyStringSchema },
);
const ProviderUsageEventSchema = traceEventWithAttribution(
  "provider.usage",
  z.object({ usage: UsageRecordSchema }),
  { provider: ProviderIdSchema, sessionId: NonEmptyStringSchema },
);
const ProviderSessionEndedEventSchema = traceEventWithAttribution(
  "provider.session_ended",
  z.object({ status: z.enum(["succeeded", "failed", "cancelled"]), error: z.string().optional() }),
  { provider: ProviderIdSchema, sessionId: NonEmptyStringSchema },
);
const ToolRequestedEventSchema = traceEventWithAttribution(
  "tool.requested",
  z.object({ tool: NonEmptyStringSchema, input: JsonValueSchema }),
  { sessionId: NonEmptyStringSchema, callId: StableIdSchema },
);
const ToolStartedEventSchema = traceEventWithAttribution(
  "tool.started",
  z.object({ tool: NonEmptyStringSchema }),
  { sessionId: NonEmptyStringSchema, callId: StableIdSchema },
);
const ToolCompletedEventSchema = traceEventWithAttribution(
  "tool.completed",
  z.object({ output: JsonValueSchema, exitCode: z.number().int().optional() }),
  { sessionId: NonEmptyStringSchema, callId: StableIdSchema },
);
const ToolDeniedEventSchema = traceEventWithAttribution(
  "tool.denied",
  z.object({ tool: NonEmptyStringSchema, reason: NonEmptyStringSchema }),
  { sessionId: NonEmptyStringSchema, callId: StableIdSchema },
);
const WorkspaceSnapshotEventSchema = traceEvent(
  "workspace.snapshot_created",
  z.object({
    snapshotId: StableIdSchema,
    commit: z.string().trim().optional(),
    dirty: z.boolean(),
  }),
);
const WorkspaceChangeSummaryEventSchema = traceEvent(
  "workspace.file_change_summary",
  z.object({
    added: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
);
const WorkspaceDiffEventSchema = traceEvent(
  "workspace.diff_created",
  z.object({ artifact: ArtifactRefSchema }),
);
const ArtifactRecordedEventSchema = traceEvent(
  "artifact.recorded",
  z.object({ artifact: ArtifactRefSchema }),
);
const ArtifactRejectedEventSchema = traceEvent(
  "artifact.rejected_by_limit",
  z.object({
    name: NonEmptyStringSchema,
    sizeBytes: z.number().int().nonnegative(),
    limitBytes: z.number().int().positive(),
  }),
);
const VerificationStartedEventSchema = traceEvent(
  "verification.started",
  z.object({ check: NonEmptyStringSchema }),
);
const VerificationResultEventSchema = traceEvent("verification.result", VerificationResultSchema);
const ApprovalRequestedEventSchema = traceEvent(
  "approval.requested",
  z.object({ approvalKey: NonEmptyStringSchema, message: NonEmptyStringSchema }),
);
const ApprovalResolvedEventSchema = traceEvent(
  "approval.resolved",
  z.object({
    approvalKey: NonEmptyStringSchema,
    decision: z.enum(["approved", "rejected"]),
    resolvedBy: NonEmptyStringSchema,
  }),
);
const ExtractionImportedEventSchema = traceEvent(
  "extraction.imported",
  z.object({ importId: StableIdSchema, source: NonEmptyStringSchema }),
);
const ExtractionSegmentedEventSchema = traceEvent(
  "extraction.segmented",
  z.object({ importId: StableIdSchema, segmentCount: z.number().int().nonnegative() }),
);
const ExtractionProposalCreatedEventSchema = traceEvent(
  "extraction.proposal_created",
  z.object({ proposalId: StableIdSchema, importId: StableIdSchema }),
);
const ExtractionProposalApprovedEventSchema = traceEvent(
  "extraction.proposal_approved",
  z.object({ proposalId: StableIdSchema, workflowId: StableIdSchema }),
);
const RuntimeWarningEventSchema = traceEvent("runtime.warning", ContractWarningSchema);
const RuntimeCapabilityDegradedEventSchema = traceEvent(
  "runtime.capability_degraded",
  z.object({
    capability: CapabilitySchema,
    provider: ProviderIdSchema,
    reason: NonEmptyStringSchema,
  }),
);
const RuntimeRecoveryEventSchema = traceEventWithAttribution(
  "runtime.recovery",
  z
    .object({
      action: z.enum(["marked_failed", "marked_cancelled", "paused_run"]),
      reason: NonEmptyStringSchema,
    })
    .strict(),
  { attemptId: StableIdSchema },
);

export const TraceEventV1Schema = z.discriminatedUnion("type", [
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunPauseRequestedEventSchema,
  RunPausedEventSchema,
  RunResumedEventSchema,
  RunCancellingEventSchema,
  RunCompletedEventSchema,
  NodeReadyEventSchema,
  NodeStartedEventSchema,
  NodeOutputEventSchema,
  NodeBlockedEventSchema,
  NodeCompletedEventSchema,
  AttemptCreatedEventSchema,
  AttemptRetryingEventSchema,
  AttemptFailedEventSchema,
  AttemptCancelledEventSchema,
  ProviderProbedEventSchema,
  ProviderSessionStartedEventSchema,
  ProviderMessageEventSchema,
  ProviderUsageEventSchema,
  ProviderSessionEndedEventSchema,
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  ToolDeniedEventSchema,
  WorkspaceSnapshotEventSchema,
  WorkspaceChangeSummaryEventSchema,
  WorkspaceDiffEventSchema,
  ArtifactRecordedEventSchema,
  ArtifactRejectedEventSchema,
  VerificationStartedEventSchema,
  VerificationResultEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ExtractionImportedEventSchema,
  ExtractionSegmentedEventSchema,
  ExtractionProposalCreatedEventSchema,
  ExtractionProposalApprovedEventSchema,
  RuntimeWarningEventSchema,
  RuntimeCapabilityDegradedEventSchema,
  RuntimeRecoveryEventSchema,
]);
export const TraceEventSchema = TraceEventV1Schema;
export const SupportedTraceEventSchema = z.discriminatedUnion("schemaVersion", [
  TraceEventV1Schema,
]);
export const TraceEventByVersionSchema = SupportedTraceEventSchema;
export type TraceEventV1 = z.infer<typeof TraceEventV1Schema>;
export type TraceEvent = z.infer<typeof TraceEventV1Schema>;

export const NodeEvidenceSchema = z.object({
  nodeId: StableIdSchema,
  eventIds: z.array(StableIdSchema).min(1),
  rationale: NonEmptyStringSchema,
});
export type NodeEvidence = z.infer<typeof NodeEvidenceSchema>;
export const InferredInputSchema = WorkflowInputSchema.extend({
  confidence: z.number().min(0).max(1),
  observedValues: z.array(JsonValueSchema).default([]),
});
export const VerifierRequirementSchema = z.object({
  check: NonEmptyStringSchema,
  command: NonEmptyStringSchema.optional(),
  rationale: NonEmptyStringSchema,
  required: z.boolean().default(true),
});
export type VerifierRequirement = z.infer<typeof VerifierRequirementSchema>;
export const ExtractionProposalV1Schema = z
  .object({
    schemaVersion: SchemaVersionV1Schema,
    id: StableIdSchema,
    importId: StableIdSchema,
    createdAt: TimestampSchema,
    workflow: WorkflowDefinitionSchema,
    inferredInputs: z.array(InferredInputSchema).default([]),
    nodeEvidence: z.array(NodeEvidenceSchema).min(1),
    removedDetours: z
      .array(
        z.object({
          description: NonEmptyStringSchema,
          reason: NonEmptyStringSchema,
          eventIds: z.array(StableIdSchema).min(1),
        }),
      )
      .default([]),
    warnings: z.array(ContractWarningSchema).default([]),
    verifierRequirements: z.array(VerifierRequirementSchema).min(1),
    proposedPolicies: WorkflowPolicySchema,
    expectedSideEffects: z.array(NonEmptyStringSchema).default([]),
    unresolvedQuestions: z
      .array(z.object({ question: NonEmptyStringSchema, blocksExecution: z.boolean() }))
      .default([]),
    status: z.enum(["draft", "approved", "rejected"]).default("draft"),
  })
  .superRefine((proposal, ctx) => {
    const knownNodeIds = new Set(proposal.workflow.nodes.map((node) => node.id));
    for (const [index, evidence] of proposal.nodeEvidence.entries()) {
      if (!knownNodeIds.has(evidence.nodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodeEvidence", index, "nodeId"],
          message: "Evidence must reference a node present in the proposed workflow.",
        });
      }
    }
    if (
      proposal.status === "approved" &&
      proposal.unresolvedQuestions.some((question) => question.blocksExecution)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A proposal with blocking unresolved questions cannot be approved.",
      });
    }
  });
export const ExtractionProposalSchema = ExtractionProposalV1Schema;
export const SupportedExtractionProposalSchema = z.discriminatedUnion("schemaVersion", [
  ExtractionProposalV1Schema,
]);
export const ExtractionProposalByVersionSchema = SupportedExtractionProposalSchema;
export type ExtractionProposalV1 = z.infer<typeof ExtractionProposalV1Schema>;
export type ExtractionProposal = z.infer<typeof ExtractionProposalV1Schema>;

export const ProviderBindingSchema = z.object({
  provider: ProviderIdSchema,
  model: NonEmptyStringSchema,
  reasoning: ReasoningLevelSchema.optional(),
  capabilities: z.array(CapabilityRequirementSchema).default([]),
});
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;

const ExecutionNodeBaseSchema = z.object({
  nodeId: StableIdSchema,
  name: NonEmptyStringSchema,
  tags: z.array(NonEmptyStringSchema).default([]),
  timeoutMs: z.number().int().positive(),
  retry: RetryPolicySchema,
});
const ExecutionAgentNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("agent"),
  configuration: z.object({
    prompt: NonEmptyStringSchema,
    skills: z.array(NonEmptyStringSchema).default([]),
    inputBindings: z.record(z.string(), ValueReferenceSchema).default({}),
    completionContract: z.enum(["node_completion", "json"]).default("node_completion"),
  }),
  binding: ProviderBindingSchema,
});
const ExecutionVerifyNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("verify"),
  configuration: z.object({
    commands: z.array(VerifyCommandSchema).min(1),
    success: z.enum(["all", "any"]).default("all"),
    expectedExitCode: z.number().int().default(0),
  }),
});
const ExecutionApprovalNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("approval"),
  configuration: z.object({
    message: NonEmptyStringSchema,
    approvalKey: NonEmptyStringSchema,
    expiresAfterMs: z.number().int().positive().optional(),
  }),
});
const ExecutionRouteNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("route"),
  configuration: z.object({
    expression: NonEmptyStringSchema,
    defaultRoute: NonEmptyStringSchema.optional(),
  }),
});
const ExecutionJoinNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("join"),
  configuration: z.object({
    policy: z.enum(["all", "any", "quorum"]).default("all"),
    quorum: z.number().int().positive().optional(),
    outputMode: z.enum(["array", "object", "first_success"]).default("array"),
  }),
});
const ExecutionTransformNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("transform"),
  configuration: z.object({
    operation: z.enum(["pick", "merge", "template"]),
    mapping: z.record(z.string(), ValueReferenceSchema).default({}),
  }),
});
export const ExecutionNodeSchema = z.discriminatedUnion("kind", [
  ExecutionAgentNodeSchema,
  ExecutionVerifyNodeSchema,
  ExecutionApprovalNodeSchema,
  ExecutionRouteNodeSchema,
  ExecutionJoinNodeSchema,
  ExecutionTransformNodeSchema,
]);
export type ExecutionNode = z.infer<typeof ExecutionNodeSchema>;

export const ExecutionTopologySchema = z.object({
  startNodeIds: z.array(StableIdSchema).min(1),
  terminalNodeIds: z.array(StableIdSchema).min(1),
  topologicalOrder: z.array(StableIdSchema).min(1),
});
export type ExecutionTopology = z.infer<typeof ExecutionTopologySchema>;

export const ExecutionPlanV1Schema = z
  .object({
    schemaVersion: SchemaVersionV1Schema,
    id: StableIdSchema,
    workflowId: StableIdSchema,
    workflowVersion: z.number().int().positive(),
    compiledAt: TimestampSchema,
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    providers: z.array(ProviderInstallationSchema).min(1),
    nodes: z.array(ExecutionNodeSchema).min(1),
    edges: z.array(WorkflowEdgeSchema),
    topology: ExecutionTopologySchema,
    policies: WorkflowPolicySchema,
    warnings: z.array(ContractWarningSchema).default([]),
  })
  .superRefine((plan, ctx) => {
    const providerIds = new Set<string>();
    for (const [index, provider] of plan.providers.entries()) {
      if (providerIds.has(provider.provider)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "provider"],
          message: "An execution plan cannot install the same provider more than once.",
        });
      }
      providerIds.add(provider.provider);
    }
    const nodeIds = new Set(plan.nodes.map((node) => node.nodeId));
    const installed = new Map(plan.providers.map((provider) => [provider.provider, provider]));
    for (const [index, node] of plan.nodes.entries()) {
      if (node.kind !== "agent") continue;
      const installation = installed.get(node.binding.provider);
      if (!installation) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "binding", "provider"],
          message: "Every agent binding must reference an installed provider in this plan.",
        });
        continue;
      }
      if (!installation.installed) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "binding", "provider"],
          message: "An agent cannot bind to a provider that is not installed.",
        });
      }
      for (const [capabilityIndex, requirement] of node.binding.capabilities.entries()) {
        if (requirement.level !== "required") continue;
        if (installation.capabilities[requirement.capability] !== true) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", index, "binding", "capabilities", capabilityIndex],
            message: `Required capability '${requirement.capability}' is not available from the bound provider.`,
          });
        }
      }
    }
    for (const [index, edge] of plan.edges.entries()) {
      if (!nodeIds.has(edge.source)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index, "source"],
          message: "Execution edges must reference nodes in the resolved graph.",
        });
      }
      if (!nodeIds.has(edge.target)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index, "target"],
          message: "Execution edges must reference nodes in the resolved graph.",
        });
      }
    }
    const topologyIds = [
      ...plan.topology.startNodeIds,
      ...plan.topology.terminalNodeIds,
      ...plan.topology.topologicalOrder,
    ];
    for (const nodeId of topologyIds) {
      if (!nodeIds.has(nodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["topology"],
          message: "Execution topology must reference nodes in the resolved graph.",
        });
        break;
      }
    }
  });
export const ExecutionPlanSchema = ExecutionPlanV1Schema;
export const SupportedExecutionPlanSchema = z.discriminatedUnion("schemaVersion", [
  ExecutionPlanV1Schema,
]);
export const ExecutionPlanByVersionSchema = SupportedExecutionPlanSchema;
export type ExecutionPlanV1 = z.infer<typeof ExecutionPlanV1Schema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanV1Schema>;

const CommandBaseSchema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  commandId: StableIdSchema,
});
export const WorkflowPatchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: NodeSchema }).strict(),
  z.object({ op: z.literal("remove_node"), nodeId: StableIdSchema }).strict(),
  z.object({ op: z.literal("replace_node"), node: NodeSchema }).strict(),
  z.object({ op: z.literal("add_edge"), edge: WorkflowEdgeSchema }).strict(),
  z.object({ op: z.literal("remove_edge"), edgeId: StableIdSchema }).strict(),
  z.object({ op: z.literal("set_workflow_name"), name: NonEmptyStringSchema }).strict(),
  z
    .object({
      op: z.literal("set_node_prompt"),
      nodeId: StableIdSchema,
      prompt: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("set_route_default"),
      nodeId: StableIdSchema,
      defaultRoute: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("set_edge_label"),
      edgeId: StableIdSchema,
      label: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("set_edge_condition"),
      edgeId: StableIdSchema,
      condition: NonEmptyStringSchema,
    })
    .strict(),
]);
export type WorkflowPatchOperation = z.infer<typeof WorkflowPatchOperationSchema>;
export const WorkflowPatchCommandSchema = CommandBaseSchema.extend({
  type: z.literal("workflow.patch"),
  workflowId: StableIdSchema,
  baseVersion: z.number().int().positive(),
  patch: z.array(WorkflowPatchOperationSchema).min(1),
});
export const WorkflowValidateCommandSchema = CommandBaseSchema.extend({
  type: z.literal("workflow.validate"),
  workflow: WorkflowDefinitionSchema,
});
export const StartRunCommandSchema = CommandBaseSchema.extend({
  type: z.literal("run.start"),
  workflowId: StableIdSchema,
  workflowVersion: z.number().int().positive(),
  inputs: JsonObjectSchema.default({}),
});
export const PauseRunCommandSchema = CommandBaseSchema.extend({
  type: z.literal("run.pause"),
  runId: StableIdSchema,
});
export const ResumeRunCommandSchema = CommandBaseSchema.extend({
  type: z.literal("run.resume"),
  runId: StableIdSchema,
});
export const CancelRunCommandSchema = CommandBaseSchema.extend({
  type: z.literal("run.cancel"),
  runId: StableIdSchema,
  reason: NonEmptyStringSchema.optional(),
});
export const RetryNodeCommandSchema = CommandBaseSchema.extend({
  type: z.literal("run.retry_node"),
  runId: StableIdSchema,
  nodeId: StableIdSchema,
  inputs: JsonObjectSchema.optional(),
});
export const ForkRunCommandSchema = CommandBaseSchema.extend({
  type: z.literal("run.fork"),
  runId: StableIdSchema,
  fromNodeId: StableIdSchema,
  workflowVersion: z.number().int().positive().optional(),
});
export const ReplayRunCommandSchema = CommandBaseSchema.extend({
  type: z.literal("run.replay"),
  runId: StableIdSchema,
  fromSequence: z.number().int().nonnegative().optional(),
});
export const ExportTraceCommandSchema = CommandBaseSchema.extend({
  type: z.literal("trace.export"),
  runId: StableIdSchema,
  outputPath: z.string().trim().optional(),
});
export const ImportTraceCommandSchema = CommandBaseSchema.extend({
  type: z.literal("trace.import"),
  path: NonEmptyStringSchema,
});
export const LocalCommandV1Schema = z.discriminatedUnion("type", [
  WorkflowPatchCommandSchema,
  WorkflowValidateCommandSchema,
  StartRunCommandSchema,
  PauseRunCommandSchema,
  ResumeRunCommandSchema,
  CancelRunCommandSchema,
  RetryNodeCommandSchema,
  ForkRunCommandSchema,
  ReplayRunCommandSchema,
  ExportTraceCommandSchema,
  ImportTraceCommandSchema,
]);
export const LocalCommandSchema = LocalCommandV1Schema;
export const SupportedLocalCommandSchema = z.union([LocalCommandV1Schema]);
export const LocalCommandByVersionSchema = SupportedLocalCommandSchema;
export type LocalCommandV1 = z.infer<typeof LocalCommandV1Schema>;
export type LocalCommand = z.infer<typeof LocalCommandV1Schema>;
export const CommandResultV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  commandId: StableIdSchema,
  accepted: z.boolean(),
  message: z.string(),
  runId: StableIdSchema.optional(),
  workflowId: StableIdSchema.optional(),
  errors: z.array(ContractWarningSchema).default([]),
});
export const CommandResultSchema = CommandResultV1Schema;
export const SupportedCommandResultSchema = z.discriminatedUnion("schemaVersion", [
  CommandResultV1Schema,
]);
export const CommandResultByVersionSchema = SupportedCommandResultSchema;
export type CommandResultV1 = z.infer<typeof CommandResultV1Schema>;
export type CommandResult = z.infer<typeof CommandResultV1Schema>;

export const PublicPersistedSchemas = {
  WorkflowDefinition: WorkflowDefinitionSchema,
  ProviderCapabilities: ProviderCapabilitiesSchema,
  ProviderInstallation: ProviderInstallationSchema,
  NodeCompletion: NodeCompletionSchema,
  TraceEvent: TraceEventSchema,
  ExtractionProposal: ExtractionProposalSchema,
  ExecutionPlan: ExecutionPlanSchema,
  LocalCommand: LocalCommandSchema,
  CommandResult: CommandResultSchema,
} as const;

/** Version-dispatch map used by readers that accept any supported revision. */
export const SupportedPersistedSchemas = {
  WorkflowDefinition: SupportedWorkflowDefinitionSchema,
  ProviderCapabilities: SupportedProviderCapabilitiesSchema,
  ProviderInstallation: SupportedProviderInstallationSchema,
  NodeCompletion: SupportedNodeCompletionSchema,
  TraceEvent: SupportedTraceEventSchema,
  ExtractionProposal: SupportedExtractionProposalSchema,
  ExecutionPlan: SupportedExecutionPlanSchema,
  LocalCommand: SupportedLocalCommandSchema,
  CommandResult: SupportedCommandResultSchema,
} as const;
