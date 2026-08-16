import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CommandResultSchema,
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

// The checked-in fixture predates the v1 structured value-reference shape;
// keep this test useful while the shared fixture is migrated by normalizing
// only those legacy fields at the test boundary.
const validWorkflowFixture = (): unknown => {
  const raw = fixture("valid-basic.json") as Record<string, unknown>;
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return node;
        const record = node as Record<string, unknown>;
        if (record.kind !== "agent") return node;
        const bindings = record.inputBindings;
        const inputBindings =
          bindings && typeof bindings === "object" && !Array.isArray(bindings)
            ? Object.fromEntries(
                Object.entries(bindings as Record<string, unknown>).map(([name, value]) => [
                  name,
                  typeof value === "string"
                    ? { kind: "workflow_input", name: value.replace(/^\{\{|\}\}$/g, "").trim() }
                    : value,
                ]),
              )
            : bindings;
        const requiredCapabilities = Array.isArray(record.requiredCapabilities)
          ? record.requiredCapabilities.map((capability) =>
              typeof capability === "string" ? { capability, level: "required" } : capability,
            )
          : record.requiredCapabilities;
        return { ...record, inputBindings, requiredCapabilities };
      })
    : raw.nodes;
  return { ...raw, nodes };
};

test("valid workflow fixture parses and defaults are applied", () => {
  const result = WorkflowDefinitionSchema.safeParse(validWorkflowFixture());
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
