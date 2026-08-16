import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CommandResultSchema,
  ExecutionPlanSchema,
  emitJsonSchema,
  emitPublicJsonSchemas,
  LocalCommandSchema,
  NodeCompletionSchema,
  SCHEMA_VERSION,
  TraceEventSchema,
  WorkflowDefinitionSchema,
} from "../src/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "../../../fixtures/workflows", name), "utf8"));

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
    provider: "codex",
    sessionId: "session-1",
    callId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    parentEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    type: "tool.completed",
    payload: { output: { ok: true }, exitCode: 0 },
  });
  expect(event.sessionId).toBe("session-1");
  expect(event.callId).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  expect("sessionId" in event.payload).toBe(false);
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
