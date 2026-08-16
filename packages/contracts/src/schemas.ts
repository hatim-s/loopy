import { z } from "zod";

/** The first persisted contract revision. Bump deliberately when breaking a shape. */
export const SCHEMA_VERSION = "1" as const;
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

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
  inputBindings: z.record(z.string(), JsonValueSchema).default({}),
  requiredCapabilities: z.array(NonEmptyStringSchema).default([]),
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
  mapping: z.record(z.string(), JsonValueSchema).default({}),
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

export const WorkflowDefinitionSchema = z.object({
  schemaVersion: SchemaVersionSchema,
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
  triggers: z
    .object({ manual: z.boolean().default(true), schedule: z.string().trim().optional() })
    .default({ manual: true }),
  metadata: z.object({
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    createdFrom: z.enum(["manual", "extraction", "import"]).default("manual"),
    extractionId: StableIdSchema.optional(),
    tags: z.array(NonEmptyStringSchema).default([]),
  }),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const ProviderCapabilitiesSchema = z.object({
  schemaVersion: SchemaVersionSchema,
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
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderInstallationSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  provider: ProviderIdSchema,
  installed: z.boolean(),
  executable: z.string().trim().optional(),
  version: z.string().trim().optional(),
  path: z.string().trim().optional(),
  detectedAt: TimestampSchema,
  capabilities: ProviderCapabilitiesSchema,
  diagnostic: z.string().trim().optional(),
});
export type ProviderInstallation = z.infer<typeof ProviderInstallationSchema>;

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
export const NodeCompletionSchema = z.object({
  schemaVersion: SchemaVersionSchema,
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
export type NodeCompletion = z.infer<typeof NodeCompletionSchema>;

const TraceEventBaseSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  id: StableIdSchema,
  runId: StableIdSchema,
  nodeId: StableIdSchema.optional(),
  attemptId: StableIdSchema.optional(),
  sequence: z.number().int().nonnegative(),
  occurredAt: TimestampSchema,
  monotonicOffsetMs: z.number().nonnegative(),
  provider: ProviderIdSchema.optional(),
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
const NodeReadyEventSchema = traceEvent("node.ready", z.object({ nodeId: StableIdSchema }));
const NodeStartedEventSchema = traceEvent(
  "node.started",
  z.object({ nodeId: StableIdSchema, attemptId: StableIdSchema }),
);
const NodeOutputEventSchema = traceEvent(
  "node.output",
  z.object({ nodeId: StableIdSchema, output: JsonObjectSchema }),
);
const NodeBlockedEventSchema = traceEvent(
  "node.blocked",
  z.object({ nodeId: StableIdSchema, reason: NonEmptyStringSchema }),
);
const NodeCompletedEventSchema = traceEvent(
  "node.completed",
  z.object({ nodeId: StableIdSchema, completion: NodeCompletionSchema }),
);
const AttemptCreatedEventSchema = traceEvent(
  "attempt.created",
  z.object({
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
    attempt: z.number().int().positive(),
  }),
);
const AttemptRetryingEventSchema = traceEvent(
  "attempt.retrying",
  z.object({
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
    nextAttempt: z.number().int().positive(),
    reason: NonEmptyStringSchema,
  }),
);
const AttemptFailedEventSchema = traceEvent(
  "attempt.failed",
  z.object({ nodeId: StableIdSchema, attemptId: StableIdSchema, error: NonEmptyStringSchema }),
);
const AttemptCancelledEventSchema = traceEvent(
  "attempt.cancelled",
  z.object({ nodeId: StableIdSchema, attemptId: StableIdSchema, reason: NonEmptyStringSchema }),
);
const ProviderProbedEventSchema = traceEvent(
  "provider.probed",
  z.object({ installation: ProviderInstallationSchema }),
);
const ProviderSessionStartedEventSchema = traceEvent(
  "provider.session_started",
  z.object({ session: ProviderSessionRefSchema }),
);
const ProviderMessageEventSchema = traceEvent(
  "provider.message",
  z.object({
    sessionId: NonEmptyStringSchema,
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
  }),
);
const ProviderUsageEventSchema = traceEvent(
  "provider.usage",
  z.object({ sessionId: NonEmptyStringSchema, usage: UsageRecordSchema }),
);
const ProviderSessionEndedEventSchema = traceEvent(
  "provider.session_ended",
  z.object({
    sessionId: NonEmptyStringSchema,
    status: z.enum(["succeeded", "failed", "cancelled"]),
    error: z.string().optional(),
  }),
);
const ToolRequestedEventSchema = traceEvent(
  "tool.requested",
  z.object({ tool: NonEmptyStringSchema, input: JsonValueSchema }),
);
const ToolStartedEventSchema = traceEvent("tool.started", z.object({ tool: NonEmptyStringSchema }));
const ToolCompletedEventSchema = traceEvent(
  "tool.completed",
  z.object({
    tool: NonEmptyStringSchema,
    output: JsonValueSchema,
    exitCode: z.number().int().optional(),
  }),
);
const ToolDeniedEventSchema = traceEvent(
  "tool.denied",
  z.object({ tool: NonEmptyStringSchema, reason: NonEmptyStringSchema }),
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
    capability: NonEmptyStringSchema,
    provider: ProviderIdSchema,
    reason: NonEmptyStringSchema,
  }),
);
const RuntimeRecoveryEventSchema = traceEvent(
  "runtime.recovery",
  z.object({
    attemptId: StableIdSchema,
    action: z.enum(["marked_failed", "marked_cancelled", "paused_run"]),
    reason: NonEmptyStringSchema,
  }),
);

export const TraceEventSchema = z.discriminatedUnion("type", [
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
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const NodeEvidenceSchema = z.object({
  nodeId: StableIdSchema,
  eventIds: z.array(StableIdSchema).min(1),
  rationale: NonEmptyStringSchema,
});
export const InferredInputSchema = WorkflowInputSchema.extend({
  confidence: z.number().min(0).max(1),
  observedValues: z.array(JsonValueSchema).default([]),
});
export const ExtractionProposalSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  id: StableIdSchema,
  importId: StableIdSchema,
  createdAt: TimestampSchema,
  workflow: WorkflowDefinitionSchema,
  inferredInputs: z.array(InferredInputSchema).default([]),
  nodeEvidence: z.array(NodeEvidenceSchema).default([]),
  removedDetours: z
    .array(
      z.object({
        description: NonEmptyStringSchema,
        reason: NonEmptyStringSchema,
        eventIds: z.array(StableIdSchema).default([]),
      }),
    )
    .default([]),
  warnings: z.array(ContractWarningSchema).default([]),
  verificationStrategy: z.array(VerificationResultSchema).default([]),
  proposedPolicies: WorkflowPolicySchema,
  expectedSideEffects: z.array(NonEmptyStringSchema).default([]),
  unresolvedQuestions: z
    .array(z.object({ question: NonEmptyStringSchema, blocksExecution: z.boolean() }))
    .default([]),
  status: z.enum(["draft", "approved", "rejected"]).default("draft"),
});
export type ExtractionProposal = z.infer<typeof ExtractionProposalSchema>;

export const ExecutionNodeSchema = z.object({
  nodeId: StableIdSchema,
  kind: z.enum(["agent", "verify", "approval", "route", "join", "transform"]),
  provider: ProviderIdSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  reasoning: ReasoningLevelSchema.optional(),
  timeoutMs: z.number().int().positive(),
  retry: RetryPolicySchema,
  requiredCapabilities: z.array(NonEmptyStringSchema).default([]),
});
export const ExecutionPlanSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  id: StableIdSchema,
  workflowId: StableIdSchema,
  workflowVersion: z.number().int().positive(),
  compiledAt: TimestampSchema,
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  provider: ProviderInstallationSchema,
  capabilities: ProviderCapabilitiesSchema,
  nodes: z.array(ExecutionNodeSchema).min(1),
  policies: WorkflowPolicySchema,
  warnings: z.array(ContractWarningSchema).default([]),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

const CommandBaseSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  commandId: StableIdSchema,
});
export const WorkflowPatchCommandSchema = CommandBaseSchema.extend({
  type: z.literal("workflow.patch"),
  workflowId: StableIdSchema,
  baseVersion: z.number().int().positive(),
  patch: JsonValueSchema,
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
export const LocalCommandSchema = z.discriminatedUnion("type", [
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
export type LocalCommand = z.infer<typeof LocalCommandSchema>;
export const CommandResultSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  commandId: StableIdSchema,
  accepted: z.boolean(),
  message: z.string(),
  runId: StableIdSchema.optional(),
  workflowId: StableIdSchema.optional(),
  errors: z.array(ContractWarningSchema).default([]),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

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
