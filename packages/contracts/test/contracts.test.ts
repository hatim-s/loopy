import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CommandResultSchema,
  ExecutionPlanSchema,
  ExecutionPlanV1Schema,
  ExtractionProposalSchema,
  emitJsonSchema,
  emitPublicJsonSchemas,
  LocalCommandSchema,
  NodeCompletionSchema,
  PredicateSchema,
  SCHEMA_VERSION,
  TraceEventSchema,
  TraceEventV1Schema,
  WorkflowDefinitionSchema,
  WorkflowDefinitionV1Schema,
} from "../src/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "../../../fixtures/workflows", name), "utf8"));

const executionIds = {
  plan: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workflow: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  first: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  second: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  edge: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};
const executionPlanInput = () => ({
  schemaVersion: "1",
  id: executionIds.plan,
  workflowId: executionIds.workflow,
  workflowVersion: 1,
  compiledAt: "2026-08-17T00:00:00.000Z",
  planHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  providers: [
    {
      schemaVersion: "1",
      provider: "codex",
      installed: true,
      detectedAt: "2026-08-17T00:00:00.000Z",
      capabilities: {
        schemaVersion: "1",
        provider: "codex",
        structuredStreamingEvents: true,
        historicalSessionImport: true,
        sessionResume: true,
        sessionFork: true,
        explicitModelSelection: true,
        explicitReasoningLevel: true,
        toolAllowlist: true,
        writablePathPolicy: true,
        networkPolicy: true,
        maxTurns: true,
        tokenBudget: true,
        monetaryBudget: true,
        timeoutCancellation: true,
        usageReporting: true,
        nestedSubagentVisibility: true,
        nativeSandbox: true,
      },
    },
  ],
  nodes: [
    {
      nodeId: executionIds.first,
      name: "First",
      tags: [],
      timeoutMs: 120000,
      retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
      kind: "verify",
      configuration: {
        commands: [{ command: "bun", args: [], timeoutMs: 120000 }],
        success: "all",
        expectedExitCode: 0,
      },
    },
    {
      nodeId: executionIds.second,
      name: "Second",
      tags: [],
      timeoutMs: 120000,
      retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
      kind: "verify",
      configuration: {
        commands: [{ command: "bun", args: [], timeoutMs: 120000 }],
        success: "all",
        expectedExitCode: 0,
      },
    },
  ],
  edges: [
    {
      id: executionIds.edge,
      source: executionIds.first,
      target: executionIds.second,
      metadata: {},
    },
  ],
  topology: {
    startNodeIds: [executionIds.first],
    terminalNodeIds: [executionIds.second],
    topologicalOrder: [executionIds.first, executionIds.second],
  },
  policies: {},
  warnings: [],
});

test("valid workflow fixture parses and defaults are applied", () => {
  const result = WorkflowDefinitionSchema.safeParse(fixture("valid-basic.json"));
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.data.nodes).toHaveLength(2);
    expect(result.data.policies.tools.network).toBe("disabled");
  }
});

test("invalid workflow fixture reports stable paths", () => {
  const result = WorkflowDefinitionSchema.safeParse(fixture("invalid-workflow.json"));
  expect(result.success).toBe(false);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("schemaVersion");
    expect(paths).toContain("workflowVersion");
    expect(paths).toContain("id");
    expect(paths).toContain("nodes");
  }
});

test("node completion and canonical trace event validate", () => {
  const completion = NodeCompletionSchema.parse({
    schemaVersion: "1",
    status: "succeeded",
    summary: "verified",
    outputs: { changed: true },
    artifacts: [],
    verification: [{ check: "tests", status: "passed", summary: "pass", details: {} }],
    warnings: [],
  });
  expect(completion.outputs.changed).toBe(true);
  const event = TraceEventSchema.parse({
    schemaVersion: "1",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequence: 0,
    occurredAt: "2026-08-17T00:00:00.000Z",
    monotonicOffsetMs: 0,
    nodeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    type: "node.completed",
    payload: { completion },
  });
  expect(event.type).toBe("node.completed");
  expect(
    TraceEventSchema.safeParse({ type: "provider.hidden_chain_of_thought", payload: {} }).success,
  ).toBe(false);
});

test("trace events keep provider sessions and tool calls correlated in the envelope", () => {
  const event = TraceEventSchema.parse({
    schemaVersion: "1",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequence: 1,
    occurredAt: "2026-08-17T00:00:00.000Z",
    monotonicOffsetMs: 10,
    nodeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    provider: "codex",
    sessionId: "session-1",
    toolCallId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    parentEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    type: "tool.completed",
    payload: { output: { ok: true }, exitCode: 0 },
  });
  expect(event.sessionId).toBe("session-1");
  expect(event.toolCallId).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  expect("sessionId" in event.payload).toBe(false);
});

test("trace family attribution is mandatory and envelope-authoritative", () => {
  const common = {
    schemaVersion: "1",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequence: 1,
    occurredAt: "2026-08-17T00:00:00.000Z",
    monotonicOffsetMs: 0,
  } as const;
  expect(TraceEventSchema.safeParse({ ...common, type: "node.started", payload: {} }).success).toBe(
    false,
  );
  expect(
    TraceEventSchema.safeParse({
      ...common,
      type: "provider.message",
      provider: "codex",
      sessionId: "session-1",
      payload: { role: "assistant", content: "hi" },
    }).success,
  ).toBe(false);
  expect(
    TraceEventSchema.safeParse({
      ...common,
      type: "tool.started",
      provider: "codex",
      sessionId: "session-1",
      nodeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      payload: { tool: "shell" },
    }).success,
  ).toBe(false);
  expect(
    TraceEventSchema.safeParse({
      ...common,
      type: "tool.started",
      provider: "codex",
      sessionId: "session-1",
      nodeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      toolCallId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      payload: { tool: "shell", nodeId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    }).success,
  ).toBe(false);
});

test("route predicates accept only the versioned safe AST", () => {
  expect(
    PredicateSchema.safeParse({
      kind: "comparison",
      operator: "equals",
      left: { kind: "reference", reference: { kind: "workflow_input", name: "result" } },
      right: { kind: "literal", value: "ok" },
    }).success,
  ).toBe(true);
  expect(PredicateSchema.safeParse("result === 'ok'").success).toBe(false);
  expect(
    PredicateSchema.safeParse({
      kind: "comparison",
      operator: "equals",
      left: { kind: "reference", reference: { kind: "workflow_input", name: "result" } },
      right: { kind: "literal", value: "ok" },
      eval: "arbitrary code",
    }).success,
  ).toBe(false);
});

test("execution plans require the complete persisted shape", () => {
  const capabilities = {
    schemaVersion: "1",
    provider: "codex",
    structuredStreamingEvents: true,
    historicalSessionImport: true,
    sessionResume: true,
    sessionFork: true,
    explicitModelSelection: true,
    explicitReasoningLevel: true,
    toolAllowlist: true,
    writablePathPolicy: true,
    networkPolicy: true,
    maxTurns: true,
    tokenBudget: true,
    monetaryBudget: true,
    timeoutCancellation: true,
    usageReporting: true,
    nestedSubagentVisibility: true,
    nativeSandbox: true,
  } as const;
  const nodeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const plan = ExecutionPlanSchema.parse({
    schemaVersion: "1",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workflowVersion: 1,
    compiledAt: "2026-08-17T00:00:00.000Z",
    planHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    providers: [
      {
        schemaVersion: "1",
        provider: "codex",
        installed: true,
        detectedAt: "2026-08-17T00:00:00.000Z",
        capabilities,
      },
    ],
    nodes: [
      {
        nodeId,
        name: "Implement",
        tags: [],
        timeoutMs: 120000,
        retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
        kind: "agent",
        configuration: {
          prompt: "Implement the requested task.",
          skills: [],
          inputBindings: {
            task: { kind: "workflow_input", name: "task" },
          },
          completionContract: "node_completion",
        },
        binding: { provider: "codex", model: "gpt-5", capabilities: [] },
      },
    ],
    edges: [],
    topology: { startNodeIds: [nodeId], terminalNodeIds: [nodeId], topologicalOrder: [nodeId] },
    policies: {},
    warnings: [],
  });
  expect(plan.nodes[0]?.kind).toBe("agent");
  expect(plan.topology.topologicalOrder).toEqual([nodeId]);
});

test("execution plan rejects topology lies, duplicate IDs, and unreachable/cyclic edges", () => {
  const duplicateNode = executionPlanInput();
  const firstNode = duplicateNode.nodes[0];
  const secondNode = duplicateNode.nodes[1];
  if (!firstNode || !secondNode) throw new Error("test fixture nodes missing");
  secondNode.nodeId = firstNode.nodeId;
  expect(ExecutionPlanSchema.safeParse(duplicateNode).success).toBe(false);

  const duplicateEdge = executionPlanInput();
  duplicateEdge.edges.push({
    id: executionIds.edge,
    source: executionIds.first,
    target: executionIds.second,
    metadata: {},
  });
  expect(ExecutionPlanSchema.safeParse(duplicateEdge).success).toBe(false);

  const omitted = executionPlanInput();
  omitted.topology.topologicalOrder = [executionIds.first];
  expect(ExecutionPlanSchema.safeParse(omitted).success).toBe(false);

  const backward = executionPlanInput();
  const backwardEdge = backward.edges[0];
  if (!backwardEdge) throw new Error("test fixture edge missing");
  backwardEdge.source = executionIds.second;
  backwardEdge.target = executionIds.first;
  backward.topology.startNodeIds = [executionIds.second];
  backward.topology.terminalNodeIds = [executionIds.first];
  backward.topology.topologicalOrder = [executionIds.first, executionIds.second];
  expect(ExecutionPlanSchema.safeParse(backward).success).toBe(false);

  const lyingRoots = executionPlanInput();
  lyingRoots.topology.startNodeIds = [executionIds.second];
  expect(ExecutionPlanSchema.safeParse(lyingRoots).success).toBe(false);
});

test("extraction proposals require complete, stable evidence coverage", () => {
  const workflow = fixture("valid-basic.json") as { nodes: Array<{ id: string }> } & Record<
    string,
    unknown
  >;
  const firstWorkflowNode = workflow.nodes[0];
  const secondWorkflowNode = workflow.nodes[1];
  if (!firstWorkflowNode || !secondWorkflowNode) throw new Error("test fixture nodes missing");
  const nodeEvidence = [
    {
      evidenceId: "55555555-5555-4555-8555-555555555555",
      nodeId: firstWorkflowNode.id,
      eventIds: ["66666666-6666-4666-8666-666666666666"],
      rationale: "The implementation step is directly observed.",
    },
    {
      evidenceId: "77777777-7777-4777-8777-777777777777",
      nodeId: secondWorkflowNode.id,
      eventIds: ["88888888-8888-4888-8888-888888888888"],
      rationale: "The verification step is directly observed.",
    },
  ];
  const firstEvidence = nodeEvidence[0];
  const secondEvidence = nodeEvidence[1];
  if (!firstEvidence || !secondEvidence) throw new Error("test fixture evidence missing");
  const proposal = {
    schemaVersion: "1",
    id: "99999999-9999-4999-8999-999999999999",
    importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: "2026-08-17T00:00:00.000Z",
    workflow,
    inferredInputs: [],
    nodeEvidence,
    verifierRequirements: [
      {
        check: "tests",
        rationale: "Observed test command.",
        evidenceIds: [secondEvidence.evidenceId],
        required: true,
      },
    ],
    proposedPolicies: { evidenceIds: [firstEvidence.evidenceId] },
    expectedSideEffects: [],
    unresolvedQuestions: [],
    warnings: [],
    status: "approved",
  };
  expect(ExtractionProposalSchema.safeParse(proposal).success).toBe(true);

  const missingCoverage = structuredClone(proposal);
  missingCoverage.nodeEvidence = [firstEvidence];
  expect(ExtractionProposalSchema.safeParse(missingCoverage).success).toBe(false);

  const unknownReference = structuredClone(proposal);
  unknownReference.proposedPolicies.evidenceIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  expect(ExtractionProposalSchema.safeParse(unknownReference).success).toBe(false);
});

test("local commands validate and require stable versioned IDs", () => {
  const command = LocalCommandSchema.parse({
    schemaVersion: "1",
    commandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    type: "run.pause",
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  expect(command.type).toBe("run.pause");
  expect(LocalCommandSchema.safeParse({ type: "run.pause", runId: "x" }).success).toBe(false);
  expect(
    CommandResultSchema.parse({
      schemaVersion: "1",
      commandId: command.commandId,
      accepted: true,
      message: "queued",
    }).errors,
  ).toEqual([]);
});

describe("public JSON Schema", () => {
  test("native Zod 4 output is deterministic and excludes runtime metadata", () => {
    const first = JSON.stringify(emitJsonSchema(WorkflowDefinitionSchema));
    expect(first).toBe(JSON.stringify(emitJsonSchema(WorkflowDefinitionSchema)));
    expect(first).not.toContain("~standard");
  });
  test("versioned schemas remain the compatibility authority behind ergonomic aliases", () => {
    expect(WorkflowDefinitionSchema).toBe(WorkflowDefinitionV1Schema);
    expect(ExecutionPlanSchema).toBe(ExecutionPlanV1Schema);
    expect(TraceEventSchema).toBe(TraceEventV1Schema);
  });
  test("only explicitly persisted contracts are emitted", () => {
    expect(Object.keys(emitPublicJsonSchemas())).toEqual([
      "CommandResult",
      "ExecutionPlan",
      "ExtractionProposal",
      "LocalCommand",
      "NodeCompletion",
      "ProviderCapabilities",
      "ProviderInstallation",
      "TraceEvent",
      "WorkflowDefinition",
    ]);
  });
  test("matches the committed deterministic schema snapshot", () => {
    const snapshot = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../fixtures/workflows/schema-snapshots.json"),
        "utf8",
      ),
    );
    expect(emitPublicJsonSchemas()).toEqual(snapshot);
  });
});
