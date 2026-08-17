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
export const CapabilityRequirementV1Schema = z.object({
  capability: CapabilitySchema,
  level: CapabilityRequirementLevelSchema.default("required"),
});
export const CapabilityRequirementSchema = CapabilityRequirementV1Schema;
export type CapabilityRequirementV1 = z.infer<typeof CapabilityRequirementV1Schema>;
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementV1Schema>;

/**
 * Dataflow is deliberately a small value-reference algebra. Arbitrary
 * expression strings are not persisted because their evaluation semantics
 * cannot be made portable between providers and runtimes.
 */
export const ValueReferenceV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: JsonValueSchema }),
  z.object({ kind: z.literal("workflow_input"), name: NonEmptyStringSchema }),
  z.object({
    kind: z.literal("node_output"),
    nodeId: StableIdSchema,
    path: z.array(NonEmptyStringSchema).default([]),
  }),
]);
export const ValueReferenceSchema = ValueReferenceV1Schema;
export type ValueReferenceV1 = z.infer<typeof ValueReferenceV1Schema>;
export type ValueReference = z.infer<typeof ValueReferenceV1Schema>;

export const WorkflowInputTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "json",
  "path",
  "directory",
]);
export const WorkflowInputV1Schema = z.object({
  name: NonEmptyStringSchema,
  type: WorkflowInputTypeSchema,
  description: z.string().trim().optional(),
  required: z.boolean().default(true),
  default: JsonValueSchema.optional(),
  secret: z.boolean().default(false),
  example: JsonValueSchema.optional(),
});
export const WorkflowInputSchema = WorkflowInputV1Schema;
export type WorkflowInputV1 = z.infer<typeof WorkflowInputV1Schema>;
export type WorkflowInput = z.infer<typeof WorkflowInputV1Schema>;

export const RetryPolicyV1Schema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(1),
  backoffMs: z.number().int().min(0).max(86_400_000).default(0),
  retryOn: z
    .array(z.enum(["provider_error", "timeout", "verification_failed", "cancelled"]))
    .default([]),
});
export const RetryPolicySchema = RetryPolicyV1Schema;
export type RetryPolicyV1 = z.infer<typeof RetryPolicyV1Schema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const ToolPolicyV1Schema = z.object({
  allow: z.array(NonEmptyStringSchema).default([]),
  deny: z.array(NonEmptyStringSchema).default([]),
  network: z.enum(["disabled", "restricted", "unrestricted"]).default("disabled"),
});
export const ToolPolicySchema = ToolPolicyV1Schema;
export const WorkspacePolicyV1Schema = z.object({
  workingDirectory: z.string().trim().min(1).optional(),
  writableRoots: z.array(z.string().trim().min(1)).default([]),
  useGitWorktree: z.boolean().default(true),
  allowDirtyWorkspace: z.boolean().default(false),
});
export const WorkspacePolicySchema = WorkspacePolicyV1Schema;
export const ApprovalPolicyV1Schema = z.object({
  requiredBefore: z.array(z.enum(["agent", "verify", "transform"])).default([]),
  sideEffectLabels: z.array(NonEmptyStringSchema).default([]),
});
export const ApprovalPolicySchema = ApprovalPolicyV1Schema;
export const BudgetPolicyV1Schema = z.object({
  maxTurns: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().default(3_600_000),
});
export const BudgetPolicySchema = BudgetPolicyV1Schema;
export const ConcurrencyPolicyV1Schema = z.object({
  maxParallel: z.number().int().positive().max(64).default(1),
});
export const ConcurrencyPolicySchema = ConcurrencyPolicyV1Schema;
export const WorkflowPolicyV1Schema = z.object({
  tools: ToolPolicyV1Schema.default({ allow: [], deny: [], network: "disabled" }),
  workspace: WorkspacePolicyV1Schema.default({
    writableRoots: [],
    useGitWorktree: true,
    allowDirtyWorkspace: false,
  }),
  approval: ApprovalPolicyV1Schema.default({ requiredBefore: [], sideEffectLabels: [] }),
  budget: BudgetPolicyV1Schema.default({ timeoutMs: 3_600_000 }),
  concurrency: ConcurrencyPolicyV1Schema.default({ maxParallel: 1 }),
});
export const WorkflowPolicySchema = WorkflowPolicyV1Schema;
export type WorkflowPolicyV1 = z.infer<typeof WorkflowPolicyV1Schema>;
export type WorkflowPolicy = z.infer<typeof WorkflowPolicyV1Schema>;

export const ProviderDefaultsV1Schema = z.object({
  provider: ProviderIdSchema,
  model: NonEmptyStringSchema.optional(),
  reasoning: ReasoningLevelSchema.optional(),
  timeoutMs: z.number().int().positive().default(3_600_000),
  retry: RetryPolicyV1Schema.default({ maxAttempts: 1, backoffMs: 0, retryOn: [] }),
});
export const ProviderDefaultsSchema = ProviderDefaultsV1Schema;
export type ProviderDefaultsV1 = z.infer<typeof ProviderDefaultsV1Schema>;
export type ProviderDefaults = z.infer<typeof ProviderDefaultsV1Schema>;

const NodeBaseSchema = z.object({
  id: StableIdSchema,
  name: NonEmptyStringSchema,
  description: z.string().trim().optional(),
  tags: z.array(NonEmptyStringSchema).default([]),
});

export const AgentNodeV1Schema = NodeBaseSchema.extend({
  kind: z.literal("agent"),
  prompt: NonEmptyStringSchema,
  provider: ProviderIdSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  reasoning: ReasoningLevelSchema.optional(),
  skills: z.array(NonEmptyStringSchema).default([]),
  inputBindings: z.record(z.string(), ValueReferenceV1Schema).default({}),
  requiredCapabilities: z.array(CapabilityRequirementV1Schema).default([]),
  completionContract: z.enum(["node_completion", "json"]).default("node_completion"),
});
export const AgentNodeSchema = AgentNodeV1Schema;
export type AgentNodeV1 = z.infer<typeof AgentNodeV1Schema>;
export const VerifyCommandV1Schema = z.object({
  command: NonEmptyStringSchema,
  args: z.array(z.string()).default([]),
  cwd: z.string().trim().optional(),
  timeoutMs: z.number().int().positive().default(120_000),
});
export const VerifyCommandSchema = VerifyCommandV1Schema;
export type VerifyCommandV1 = z.infer<typeof VerifyCommandV1Schema>;
export const VerifyNodeV1Schema = NodeBaseSchema.extend({
  kind: z.literal("verify"),
  commands: z.array(VerifyCommandV1Schema).min(1),
  success: z.enum(["all", "any"]).default("all"),
  expectedExitCode: z.number().int().default(0),
});
export const VerifyNodeSchema = VerifyNodeV1Schema;
export type VerifyNodeV1 = z.infer<typeof VerifyNodeV1Schema>;
export const ApprovalNodeV1Schema = NodeBaseSchema.extend({
  kind: z.literal("approval"),
  message: NonEmptyStringSchema,
  approvalKey: NonEmptyStringSchema,
  expiresAfterMs: z.number().int().positive().optional(),
});
export const ApprovalNodeSchema = ApprovalNodeV1Schema;
export type ApprovalNodeV1 = z.infer<typeof ApprovalNodeV1Schema>;

/** Persisted route conditions are a closed data-only AST, never source code. */
export const PredicateValueV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reference"), reference: ValueReferenceV1Schema }).strict(),
  z.object({ kind: z.literal("literal"), value: JsonValueSchema }).strict(),
]);
export type PredicateValueV1 = z.infer<typeof PredicateValueV1Schema>;
export type PredicateV1 =
  | {
      kind: "comparison";
      operator:
        | "equals"
        | "not_equals"
        | "less_than"
        | "less_than_or_equal"
        | "greater_than"
        | "greater_than_or_equal"
        | "contains";
      left: PredicateValueV1;
      right: PredicateValueV1;
    }
  | { kind: "boolean"; operator: "and" | "or"; operands: PredicateV1[] }
  | { kind: "not"; operand: PredicateV1 };
export const PredicateV1Schema: z.ZodType<PredicateV1> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("comparison"),
        operator: z.enum([
          "equals",
          "not_equals",
          "less_than",
          "less_than_or_equal",
          "greater_than",
          "greater_than_or_equal",
          "contains",
        ]),
        left: PredicateValueV1Schema,
        right: PredicateValueV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("boolean"),
        operator: z.enum(["and", "or"]),
        operands: z.array(z.lazy(() => PredicateV1Schema)).min(1),
      })
      .strict(),
    z.object({ kind: z.literal("not"), operand: z.lazy(() => PredicateV1Schema) }).strict(),
  ]),
);
export const PredicateSchema = PredicateV1Schema;
export type Predicate = PredicateV1;

export const RouteNodeV1Schema = NodeBaseSchema.extend({
  kind: z.literal("route"),
  predicate: PredicateV1Schema,
  defaultRoute: NonEmptyStringSchema.optional(),
});
export const RouteNodeSchema = RouteNodeV1Schema;
export type RouteNodeV1 = z.infer<typeof RouteNodeV1Schema>;
export const JoinNodeV1Schema = NodeBaseSchema.extend({
  kind: z.literal("join"),
  policy: z.enum(["all", "any", "quorum"]).default("all"),
  quorum: z.number().int().positive().optional(),
  outputMode: z.enum(["array", "object", "first_success"]).default("array"),
});
export const JoinNodeSchema = JoinNodeV1Schema;
export type JoinNodeV1 = z.infer<typeof JoinNodeV1Schema>;
export const TransformNodeV1Schema = NodeBaseSchema.extend({
  kind: z.literal("transform"),
  operation: z.enum(["pick", "merge", "template"]),
  mapping: z.record(z.string(), ValueReferenceV1Schema).default({}),
});
export const TransformNodeSchema = TransformNodeV1Schema;
export type TransformNodeV1 = z.infer<typeof TransformNodeV1Schema>;

export const NodeV1Schema = z.discriminatedUnion("kind", [
  AgentNodeV1Schema,
  VerifyNodeV1Schema,
  ApprovalNodeV1Schema,
  RouteNodeV1Schema,
  JoinNodeV1Schema,
  TransformNodeV1Schema,
]);
export const NodeSchema = NodeV1Schema;
export type NodeV1 = z.infer<typeof NodeV1Schema>;
export type AgentNode = z.infer<typeof AgentNodeV1Schema>;
export type VerifyNode = z.infer<typeof VerifyNodeV1Schema>;
export type ApprovalNode = z.infer<typeof ApprovalNodeV1Schema>;
export type RouteNode = z.infer<typeof RouteNodeV1Schema>;
export type JoinNode = z.infer<typeof JoinNodeV1Schema>;
export type TransformNode = z.infer<typeof TransformNodeV1Schema>;
export type WorkflowNode = z.infer<typeof NodeV1Schema>;

export const WorkflowEdgeV1Schema = z.object({
  id: StableIdSchema,
  source: StableIdSchema,
  target: StableIdSchema,
  label: NonEmptyStringSchema.optional(),
  condition: PredicateV1Schema.optional(),
  metadata: JsonObjectSchema.default({}),
});
export const WorkflowEdgeSchema = WorkflowEdgeV1Schema;
export type WorkflowEdgeV1 = z.infer<typeof WorkflowEdgeV1Schema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeV1Schema>;

export const WorkflowDefinitionV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  workflowVersion: z.number().int().positive(),
  id: StableIdSchema,
  name: NonEmptyStringSchema,
  description: z.string().trim().optional(),
  inputs: z.array(WorkflowInputV1Schema).default([]),
  nodes: z.array(NodeV1Schema).min(1),
  edges: z.array(WorkflowEdgeV1Schema).default([]),
  defaults: ProviderDefaultsV1Schema,
  policies: WorkflowPolicyV1Schema.default({
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
    capabilities: ProviderCapabilitiesV1Schema,
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

export const ProviderSessionRefV1Schema = z.object({
  provider: ProviderIdSchema,
  sessionId: NonEmptyStringSchema,
  parentSessionId: NonEmptyStringSchema.optional(),
});
export const ProviderSessionRefSchema = ProviderSessionRefV1Schema;
export type ProviderSessionRefV1 = z.infer<typeof ProviderSessionRefV1Schema>;
export const ArtifactRefV1Schema = z.object({
  id: StableIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: NonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  producerNodeId: StableIdSchema.optional(),
  sourcePath: z.string().trim().optional(),
  redacted: z.boolean().default(false),
});
export const ArtifactRefSchema = ArtifactRefV1Schema;
export type ArtifactRefV1 = z.infer<typeof ArtifactRefV1Schema>;
export type ArtifactRef = z.infer<typeof ArtifactRefV1Schema>;
export const UsageRecordV1Schema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export const UsageRecordSchema = UsageRecordV1Schema;
export type UsageRecordV1 = z.infer<typeof UsageRecordV1Schema>;
export type UsageRecord = z.infer<typeof UsageRecordV1Schema>;
export const VerificationResultV1Schema = z.object({
  check: NonEmptyStringSchema,
  status: z.enum(["passed", "failed", "skipped"]),
  summary: NonEmptyStringSchema,
  command: z.string().trim().optional(),
  details: JsonObjectSchema.default({}),
  durationMs: z.number().int().nonnegative().optional(),
});
export const VerificationResultSchema = VerificationResultV1Schema;
export type VerificationResultV1 = z.infer<typeof VerificationResultV1Schema>;
export type VerificationResult = z.infer<typeof VerificationResultV1Schema>;
export const ContractWarningV1Schema = z.object({
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  severity: z.enum(["info", "warning", "error"]),
  source: z.string().trim().optional(),
});
export const ContractWarningSchema = ContractWarningV1Schema;
export type ContractWarningV1 = z.infer<typeof ContractWarningV1Schema>;
export type ContractWarning = z.infer<typeof ContractWarningV1Schema>;
export const NodeCompletionV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  status: z.enum(["succeeded", "failed", "cancelled", "skipped"]),
  route: NonEmptyStringSchema.optional(),
  summary: z.string(),
  outputs: JsonObjectSchema.default({}),
  artifacts: z.array(ArtifactRefV1Schema).default([]),
  verification: z.array(VerificationResultV1Schema).default([]),
  providerSession: ProviderSessionRefV1Schema.optional(),
  usage: UsageRecordV1Schema.optional(),
  warnings: z.array(ContractWarningV1Schema).default([]),
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
  toolCallId: StableIdSchema.optional(),
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
  attemptId: StableIdSchema,
});
const NodeStartedEventSchema = traceEventWithAttribution("node.started", z.object({}).strict(), {
  nodeId: StableIdSchema,
  attemptId: StableIdSchema,
});
const NodeOutputEventSchema = traceEventWithAttribution(
  "node.output",
  z.object({ output: JsonObjectSchema }).strict(),
  { nodeId: StableIdSchema, attemptId: StableIdSchema },
);
const NodeBlockedEventSchema = traceEventWithAttribution(
  "node.blocked",
  z.object({ reason: NonEmptyStringSchema }).strict(),
  { nodeId: StableIdSchema, attemptId: StableIdSchema },
);
const NodeCompletedEventSchema = traceEventWithAttribution(
  "node.completed",
  z.object({ completion: NodeCompletionV1Schema }).strict(),
  { nodeId: StableIdSchema, attemptId: StableIdSchema },
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
  z.object({ installation: ProviderInstallationV1Schema }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
  },
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
  z.object({ parentSessionId: NonEmptyStringSchema.optional() }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
  },
);
const ProviderMessageEventSchema = traceEventWithAttribution(
  "provider.message",
  z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string() }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
  },
);
const ProviderUsageEventSchema = traceEventWithAttribution(
  "provider.usage",
  z.object({ usage: UsageRecordV1Schema }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
  },
);
const ProviderSessionEndedEventSchema = traceEventWithAttribution(
  "provider.session_ended",
  z
    .object({ status: z.enum(["succeeded", "failed", "cancelled"]), error: z.string().optional() })
    .strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
  },
);
const ToolRequestedEventSchema = traceEventWithAttribution(
  "tool.requested",
  z.object({ tool: NonEmptyStringSchema, input: JsonValueSchema }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
    toolCallId: StableIdSchema,
  },
);
const ToolStartedEventSchema = traceEventWithAttribution(
  "tool.started",
  z.object({ tool: NonEmptyStringSchema }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
    toolCallId: StableIdSchema,
  },
);
const ToolCompletedEventSchema = traceEventWithAttribution(
  "tool.completed",
  z.object({ output: JsonValueSchema, exitCode: z.number().int().optional() }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
    toolCallId: StableIdSchema,
  },
);
const ToolDeniedEventSchema = traceEventWithAttribution(
  "tool.denied",
  z.object({ tool: NonEmptyStringSchema, reason: NonEmptyStringSchema }).strict(),
  {
    provider: ProviderIdSchema,
    sessionId: NonEmptyStringSchema,
    nodeId: StableIdSchema,
    attemptId: StableIdSchema,
    toolCallId: StableIdSchema,
  },
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
  z.object({ artifact: ArtifactRefV1Schema }),
);
const ArtifactRecordedEventSchema = traceEvent(
  "artifact.recorded",
  z.object({ artifact: ArtifactRefV1Schema }),
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
const VerificationResultEventSchema = traceEvent("verification.result", VerificationResultV1Schema);
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
const RuntimeWarningEventSchema = traceEvent("runtime.warning", ContractWarningV1Schema);
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

export const NodeEvidenceV1Schema = z.object({
  evidenceId: StableIdSchema,
  nodeId: StableIdSchema,
  eventIds: z.array(StableIdSchema).min(1),
  rationale: NonEmptyStringSchema,
});
export const NodeEvidenceSchema = NodeEvidenceV1Schema;
export type NodeEvidenceV1 = z.infer<typeof NodeEvidenceV1Schema>;
export type NodeEvidence = z.infer<typeof NodeEvidenceV1Schema>;
export const InferredInputV1Schema = WorkflowInputV1Schema.extend({
  confidence: z.number().min(0).max(1),
  observedValues: z.array(JsonValueSchema).default([]),
  /** Source-trace provenance is mandatory for every inferred input. */
  evidenceIds: z.array(StableIdSchema).min(1),
});
export const InferredInputSchema = InferredInputV1Schema;
export type InferredInputV1 = z.infer<typeof InferredInputV1Schema>;
export const VerifierRequirementV1Schema = z.object({
  check: NonEmptyStringSchema,
  command: NonEmptyStringSchema.optional(),
  rationale: NonEmptyStringSchema,
  evidenceIds: z.array(StableIdSchema).min(1),
  required: z.boolean().default(true),
});
export const VerifierRequirementSchema = VerifierRequirementV1Schema;
export type VerifierRequirementV1 = z.infer<typeof VerifierRequirementV1Schema>;
export type VerifierRequirement = z.infer<typeof VerifierRequirementV1Schema>;
export const ProposedPoliciesV1Schema = WorkflowPolicyV1Schema.extend({
  evidenceIds: z.array(StableIdSchema).min(1),
});
export const ProposedPoliciesSchema = ProposedPoliciesV1Schema;
export type ProposedPoliciesV1 = z.infer<typeof ProposedPoliciesV1Schema>;
export const ExtractionProposalV1Schema = z
  .object({
    schemaVersion: SchemaVersionV1Schema,
    id: StableIdSchema,
    importId: StableIdSchema,
    createdAt: TimestampSchema,
    workflow: WorkflowDefinitionV1Schema,
    inferredInputs: z.array(InferredInputV1Schema).default([]),
    nodeEvidence: z.array(NodeEvidenceV1Schema).min(1),
    removedDetours: z
      .array(
        z.object({
          description: NonEmptyStringSchema,
          reason: NonEmptyStringSchema,
          eventIds: z.array(StableIdSchema).min(1),
        }),
      )
      .default([]),
    warnings: z.array(ContractWarningV1Schema).default([]),
    verifierRequirements: z.array(VerifierRequirementV1Schema).min(1),
    proposedPolicies: ProposedPoliciesV1Schema,
    expectedSideEffects: z.array(NonEmptyStringSchema).default([]),
    unresolvedQuestions: z
      .array(z.object({ question: NonEmptyStringSchema, blocksExecution: z.boolean() }))
      .default([]),
    status: z.enum(["draft", "approved", "rejected"]).default("draft"),
  })
  .superRefine((proposal, ctx) => {
    const knownNodeIds = new Set(proposal.workflow.nodes.map((node) => node.id));
    const evidenceIds = new Set<string>();
    const evidenceByNode = new Map<string, number>();
    for (const [index, evidence] of proposal.nodeEvidence.entries()) {
      if (evidenceIds.has(evidence.evidenceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodeEvidence", index, "evidenceId"],
          message: "Evidence IDs must be unique within an extraction proposal.",
        });
      }
      evidenceIds.add(evidence.evidenceId);
      if (!knownNodeIds.has(evidence.nodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodeEvidence", index, "nodeId"],
          message: "Evidence must reference a node present in the proposed workflow.",
        });
      } else {
        evidenceByNode.set(evidence.nodeId, (evidenceByNode.get(evidence.nodeId) ?? 0) + 1);
      }
    }
    for (const node of proposal.workflow.nodes) {
      if (!evidenceByNode.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodeEvidence"],
          message: `Proposed node ${node.id} is missing extraction evidence.`,
        });
      }
    }
    const validateEvidenceReferences = (ids: readonly string[], path: (string | number)[]) => {
      for (const [index, evidenceId] of ids.entries()) {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            path: [...path, index],
            message: "Evidence reference must point to an evidence record in this proposal.",
          });
        }
      }
    };
    for (const [index, requirement] of proposal.verifierRequirements.entries()) {
      validateEvidenceReferences(requirement.evidenceIds, [
        "verifierRequirements",
        index,
        "evidenceIds",
      ]);
    }
    validateEvidenceReferences(proposal.proposedPolicies.evidenceIds, [
      "proposedPolicies",
      "evidenceIds",
    ]);
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

export const ProviderBindingV1Schema = z.object({
  provider: ProviderIdSchema,
  model: NonEmptyStringSchema,
  reasoning: ReasoningLevelSchema.optional(),
  capabilities: z.array(CapabilityRequirementV1Schema).default([]),
});
export const ProviderBindingSchema = ProviderBindingV1Schema;
export type ProviderBindingV1 = z.infer<typeof ProviderBindingV1Schema>;
export type ProviderBinding = z.infer<typeof ProviderBindingV1Schema>;

const ExecutionNodeBaseSchema = z.object({
  nodeId: StableIdSchema,
  name: NonEmptyStringSchema,
  tags: z.array(NonEmptyStringSchema).default([]),
  timeoutMs: z.number().int().positive(),
  retry: RetryPolicyV1Schema,
});
const ExecutionAgentNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("agent"),
  configuration: z.object({
    prompt: NonEmptyStringSchema,
    skills: z.array(NonEmptyStringSchema).default([]),
    inputBindings: z.record(z.string(), ValueReferenceV1Schema).default({}),
    completionContract: z.enum(["node_completion", "json"]).default("node_completion"),
  }),
  binding: ProviderBindingV1Schema,
});
const ExecutionVerifyNodeSchema = ExecutionNodeBaseSchema.extend({
  kind: z.literal("verify"),
  configuration: z.object({
    commands: z.array(VerifyCommandV1Schema).min(1),
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
    predicate: PredicateV1Schema,
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
    mapping: z.record(z.string(), ValueReferenceV1Schema).default({}),
  }),
});
export const ExecutionNodeV1Schema = z.discriminatedUnion("kind", [
  ExecutionAgentNodeSchema,
  ExecutionVerifyNodeSchema,
  ExecutionApprovalNodeSchema,
  ExecutionRouteNodeSchema,
  ExecutionJoinNodeSchema,
  ExecutionTransformNodeSchema,
]);
export const ExecutionNodeSchema = ExecutionNodeV1Schema;
export type ExecutionNodeV1 = z.infer<typeof ExecutionNodeV1Schema>;
export type ExecutionNode = z.infer<typeof ExecutionNodeV1Schema>;

export const ExecutionTopologyV1Schema = z.object({
  startNodeIds: z.array(StableIdSchema).min(1),
  terminalNodeIds: z.array(StableIdSchema).min(1),
  topologicalOrder: z.array(StableIdSchema).min(1),
});
export const ExecutionTopologySchema = ExecutionTopologyV1Schema;
export type ExecutionTopologyV1 = z.infer<typeof ExecutionTopologyV1Schema>;
export type ExecutionTopology = z.infer<typeof ExecutionTopologyV1Schema>;

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export const ExecutionPlanV1Schema = z
  .object({
    schemaVersion: SchemaVersionV1Schema,
    id: StableIdSchema,
    workflowId: StableIdSchema,
    workflowVersion: z.number().int().positive(),
    compiledAt: TimestampSchema,
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    providers: z.array(ProviderInstallationV1Schema).min(1),
    nodes: z.array(ExecutionNodeV1Schema).min(1),
    edges: z.array(WorkflowEdgeV1Schema),
    topology: ExecutionTopologyV1Schema,
    policies: WorkflowPolicyV1Schema,
    warnings: z.array(ContractWarningV1Schema).default([]),
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

    const seenNodeIds = new Set<string>();
    for (const [index, node] of plan.nodes.entries()) {
      if (seenNodeIds.has(node.nodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "nodeId"],
          message: "Execution node IDs must be unique.",
        });
      }
      seenNodeIds.add(node.nodeId);
    }
    const seenEdgeIds = new Set<string>();
    for (const [index, edge] of plan.edges.entries()) {
      if (seenEdgeIds.has(edge.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index, "id"],
          message: "Execution edge IDs must be unique.",
        });
      }
      seenEdgeIds.add(edge.id);
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

    const order = plan.topology.topologicalOrder;
    const orderIndex = new Map<string, number>();
    for (const [index, nodeId] of order.entries()) {
      if (!nodeIds.has(nodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["topology", "topologicalOrder", index],
          message: "Topological order must reference every resolved node exactly once.",
        });
      }
      if (orderIndex.has(nodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["topology", "topologicalOrder", index],
          message: "Topological order must not contain duplicate nodes.",
        });
      }
      orderIndex.set(nodeId, index);
    }
    if (order.length !== nodeIds.size || [...nodeIds].some((nodeId) => !orderIndex.has(nodeId))) {
      ctx.addIssue({
        code: "custom",
        path: ["topology", "topologicalOrder"],
        message: "Topological order must be an exact permutation of all execution nodes.",
      });
    }

    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const nodeId of nodeIds) {
      incoming.set(nodeId, 0);
      outgoing.set(nodeId, 0);
      adjacency.set(nodeId, []);
    }
    for (const [index, edge] of plan.edges.entries()) {
      const sourceIndex = orderIndex.get(edge.source);
      const targetIndex = orderIndex.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      if (sourceIndex >= targetIndex) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message:
            "Every execution edge must point forward in topological order; cycles are not allowed.",
        });
      }
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }
    const derivedStarts = new Set([...nodeIds].filter((nodeId) => incoming.get(nodeId) === 0));
    const derivedTerminals = new Set([...nodeIds].filter((nodeId) => outgoing.get(nodeId) === 0));
    const startIds = new Set(plan.topology.startNodeIds);
    const terminalIds = new Set(plan.topology.terminalNodeIds);
    if (
      startIds.size !== plan.topology.startNodeIds.length ||
      !setsEqual(startIds, derivedStarts)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["topology", "startNodeIds"],
        message: "Declared starts must exactly equal graph roots.",
      });
    }
    if (
      terminalIds.size !== plan.topology.terminalNodeIds.length ||
      !setsEqual(terminalIds, derivedTerminals)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["topology", "terminalNodeIds"],
        message: "Declared terminals must exactly equal graph leaves.",
      });
    }
    const reachable = new Set<string>();
    const queue = [...startIds];
    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId || reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      queue.push(...(adjacency.get(nodeId) ?? []));
    }
    if ([...nodeIds].some((nodeId) => !reachable.has(nodeId))) {
      ctx.addIssue({
        code: "custom",
        path: ["topology"],
        message: "Every execution node must be reachable from a declared start.",
      });
    }
  });
export const ExecutionPlanSchema = ExecutionPlanV1Schema;
export const SupportedExecutionPlanSchema = z.discriminatedUnion("schemaVersion", [
  ExecutionPlanV1Schema,
]);
export const ExecutionPlanByVersionSchema = SupportedExecutionPlanSchema;
export type ExecutionPlanV1 = z.infer<typeof ExecutionPlanV1Schema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanV1Schema>;

const CommandBaseV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  commandId: StableIdSchema,
});
export const WorkflowPatchOperationV1Schema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: NodeV1Schema }).strict(),
  z.object({ op: z.literal("remove_node"), nodeId: StableIdSchema }).strict(),
  z.object({ op: z.literal("replace_node"), node: NodeV1Schema }).strict(),
  z.object({ op: z.literal("add_edge"), edge: WorkflowEdgeV1Schema }).strict(),
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
      condition: PredicateV1Schema,
    })
    .strict(),
]);
export const WorkflowPatchOperationSchema = WorkflowPatchOperationV1Schema;
export type WorkflowPatchOperationV1 = z.infer<typeof WorkflowPatchOperationV1Schema>;
export type WorkflowPatchOperation = z.infer<typeof WorkflowPatchOperationV1Schema>;
export const WorkflowPatchCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("workflow.patch"),
  workflowId: StableIdSchema,
  baseVersion: z.number().int().positive(),
  patch: z.array(WorkflowPatchOperationV1Schema).min(1),
});
export const WorkflowPatchCommandSchema = WorkflowPatchCommandV1Schema;
export const WorkflowValidateCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("workflow.validate"),
  workflow: WorkflowDefinitionV1Schema,
});
export const WorkflowValidateCommandSchema = WorkflowValidateCommandV1Schema;
export const StartRunCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("run.start"),
  workflowId: StableIdSchema,
  workflowVersion: z.number().int().positive(),
  inputs: JsonObjectSchema.default({}),
});
export const StartRunCommandSchema = StartRunCommandV1Schema;
export const PauseRunCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("run.pause"),
  runId: StableIdSchema,
});
export const PauseRunCommandSchema = PauseRunCommandV1Schema;
export const ResumeRunCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("run.resume"),
  runId: StableIdSchema,
});
export const ResumeRunCommandSchema = ResumeRunCommandV1Schema;
export const CancelRunCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("run.cancel"),
  runId: StableIdSchema,
  reason: NonEmptyStringSchema.optional(),
});
export const CancelRunCommandSchema = CancelRunCommandV1Schema;
export const RetryNodeCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("run.retry_node"),
  runId: StableIdSchema,
  nodeId: StableIdSchema,
  inputs: JsonObjectSchema.optional(),
});
export const RetryNodeCommandSchema = RetryNodeCommandV1Schema;
export const ForkRunCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("run.fork"),
  runId: StableIdSchema,
  fromNodeId: StableIdSchema,
  workflowVersion: z.number().int().positive().optional(),
});
export const ForkRunCommandSchema = ForkRunCommandV1Schema;
export const ReplayRunCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("run.replay"),
  runId: StableIdSchema,
  fromSequence: z.number().int().nonnegative().optional(),
});
export const ReplayRunCommandSchema = ReplayRunCommandV1Schema;
export const ExportTraceCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("trace.export"),
  runId: StableIdSchema,
  outputPath: z.string().trim().optional(),
});
export const ExportTraceCommandSchema = ExportTraceCommandV1Schema;
export const ImportTraceCommandV1Schema = CommandBaseV1Schema.extend({
  type: z.literal("trace.import"),
  path: NonEmptyStringSchema,
});
export const ImportTraceCommandSchema = ImportTraceCommandV1Schema;
export const LocalCommandV1Schema = z.discriminatedUnion("type", [
  WorkflowPatchCommandV1Schema,
  WorkflowValidateCommandV1Schema,
  StartRunCommandV1Schema,
  PauseRunCommandV1Schema,
  ResumeRunCommandV1Schema,
  CancelRunCommandV1Schema,
  RetryNodeCommandV1Schema,
  ForkRunCommandV1Schema,
  ReplayRunCommandV1Schema,
  ExportTraceCommandV1Schema,
  ImportTraceCommandV1Schema,
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
  errors: z.array(ContractWarningV1Schema).default([]),
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
