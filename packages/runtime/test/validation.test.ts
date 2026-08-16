import { describe, expect, test } from "bun:test";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import { compileWorkflow, validateWorkflow } from "../src/index.ts";

const agent = (id: string, prompt = "Do the work") => ({ id, kind: "agent", prompt });
const verify = (id: string) => ({ id, kind: "verify", commands: ["bun test"] });

function codes(workflow: unknown): string[] {
  return validateWorkflow(workflow).diagnostics.map((item) => item.code);
}

type FixtureRecord = Record<string, unknown>;
type FixtureWorkflow = FixtureRecord & {
  nodes: FixtureRecord[];
  edges: FixtureRecord[];
};

async function canonicalFixture(): Promise<FixtureWorkflow> {
  return structuredClone(
    await Bun.file(new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url)).json(),
  ) as FixtureWorkflow;
}

function fixtureNode(workflow: FixtureWorkflow, index: number): FixtureRecord {
  const node = workflow.nodes[index];
  if (!node) throw new Error(`Fixture node ${index} is missing.`);
  return node;
}

function fixtureEdge(workflow: FixtureWorkflow, index: number): FixtureRecord {
  const edge = workflow.edges[index];
  if (!edge) throw new Error(`Fixture edge ${index} is missing.`);
  return edge;
}

describe("workflow graph validation", () => {
  test("validates a linear workflow but rejects its non-contract shape for compilation", () => {
    const workflow = {
      id: "linear",
      workflowVersion: 1,
      nodes: [agent("start"), verify("done")],
      edges: [{ id: "edge", source: "start", target: "done" }],
    };
    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    expect(result.graph.startNodeIds).toEqual(["start"]);
    expect(result.graph.terminalNodeIds).toEqual(["done"]);
    expect(result.graph.topologicalOrder).toEqual(["start", "done"]);
    const compiled = compileWorkflow(workflow);
    expect(compiled.ok).toBe(false);
    expect(compiled.diagnostics.some((item) => item.code === "WORKFLOW_CONTRACT_INVALID")).toBe(
      true,
    );
  });

  test("accepts a canonical contract workflow", async () => {
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
    ).json();
    const workflow = WorkflowDefinitionSchema.parse(fixture);
    const result = compileWorkflow(workflow);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.workflowId).toBe(workflow.id);
      expect(result.plan.schemaVersion).toBe(workflow.schemaVersion);
      expect(result.plan.topology.topologicalOrder).toHaveLength(workflow.nodes.length);
    }
  });

  test("accepts the checked-in branch/join fixture", async () => {
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/validation/valid-branch-join.json", import.meta.url),
    ).json();
    const result = validateWorkflow(fixture);
    expect(result.valid).toBe(true);
    expect(result.graph.terminalNodeIds).toEqual(["approve"]);
  });

  test("reports the checked-in invalid fixture", async () => {
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/validation/invalid-route-cycle.json", import.meta.url),
    ).json();
    expect(codes(fixture)).toEqual(
      expect.arrayContaining([
        "ROUTE_LABEL_REQUIRED",
        "JOIN_INCOMING_REQUIRED",
        "CYCLE_UNSUPPORTED",
      ]),
    );
  });

  test.each([
    ["duplicate node ids", { nodes: [agent("a"), agent("a")], edges: [] }, "DUPLICATE_NODE_ID"],
    [
      "duplicate edge ids",
      {
        nodes: [agent("a"), verify("b")],
        edges: [
          { id: "e", source: "a", target: "b" },
          { id: "e", source: "a", target: "b" },
        ],
      },
      "DUPLICATE_EDGE_ID",
    ],
    [
      "missing endpoint",
      { nodes: [agent("a")], edges: [{ id: "e", source: "a", target: "missing" }] },
      "EDGE_ENDPOINT_MISSING",
    ],
    [
      "cycle",
      {
        nodes: [agent("a"), verify("b")],
        edges: [
          { id: "ab", source: "a", target: "b" },
          { id: "ba", source: "b", target: "a" },
        ],
      },
      "CYCLE_UNSUPPORTED",
    ],
    [
      "unreachable subgraph",
      {
        nodes: [agent("a"), verify("b"), verify("orphan")],
        edges: [{ id: "ab", source: "a", target: "b" }],
      },
      "DISCONNECTED_SUBGRAPH",
    ],
    [
      "missing terminal",
      {
        nodes: [agent("a"), verify("b")],
        edges: [
          { id: "ab", source: "a", target: "b" },
          { id: "ba", source: "b", target: "a" },
        ],
      },
      "NO_REACHABLE_TERMINAL",
    ],
  ] as const)("reports %s", (_name, workflow, code) => {
    expect(codes(workflow)).toContain(code);
  });

  test("reports exact JSON pointer paths for malformed fields", () => {
    const result = validateWorkflow({
      nodes: [{ id: "start", kind: "agent" }],
      edges: [{ id: "e", source: "start", target: "missing" }],
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "NODE_REQUIRED_FIELD",
          path: "/nodes/0/prompt",
          pathSegments: ["nodes", 0, "prompt"],
        }),
        expect.objectContaining({
          code: "EDGE_ENDPOINT_MISSING",
          path: "/edges/0/target",
          pathSegments: ["edges", 0, "target"],
        }),
      ]),
    );
  });

  test("requires labelled, unique route edges", () => {
    const workflow = {
      nodes: [{ id: "route", kind: "route" }, verify("done-a"), verify("done-b")],
      edges: [
        { id: "a", source: "route", target: "done-a", label: "same" },
        { id: "b", source: "route", target: "done-b", label: "same" },
      ],
    };
    expect(codes(workflow)).toContain("ROUTE_LABEL_DUPLICATE");
  });

  test("does not treat edge conditions as route labels", () => {
    const workflow = {
      nodes: [{ id: "route", kind: "route" }, verify("done")],
      edges: [
        {
          id: "e",
          source: "route",
          target: "done",
          condition: {
            kind: "comparison",
            operator: "equals",
            left: { kind: "literal", value: "result" },
            right: { kind: "literal", value: "success" },
          },
        },
      ],
    };
    const result = validateWorkflow(workflow);
    expect(codes(workflow)).toContain("ROUTE_LABEL_REQUIRED");
    expect(result.graph.edges[0]?.route).toBeUndefined();
    expect(result.graph.edges[0]?.condition).toEqual(workflow.edges[0]?.condition);
  });

  test("validates references nested in edge predicates", () => {
    const workflow = {
      inputs: [{ name: "result" }],
      nodes: [agent("start"), verify("done")],
      edges: [
        {
          id: "e",
          source: "start",
          target: "done",
          condition: {
            kind: "boolean",
            operator: "and",
            operands: [
              {
                kind: "comparison",
                operator: "equals",
                left: {
                  kind: "reference",
                  reference: { kind: "workflow_input", name: "missing" },
                },
                right: { kind: "literal", value: "success" },
              },
            ],
          },
        },
      ],
    };
    expect(validateWorkflow(workflow).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WORKFLOW_INPUT_REFERENCE_INVALID",
          path: "/edges/0/condition/operands/0/left/reference/name",
          edgeId: "e",
        }),
      ]),
    );
  });

  test("validates a route node default against outgoing labels", () => {
    const workflow = {
      nodes: [{ id: "route", kind: "route", defaultRoute: "fallback" }, verify("done")],
      edges: [{ id: "e", source: "route", target: "done", label: "success" }],
    };
    expect(codes(workflow)).toContain("ROUTE_OUTGOING_INCONSISTENT");
  });

  test("checks optional route declarations against outgoing labels", () => {
    const workflow = {
      nodes: [{ id: "route", kind: "route", routes: ["success", "failure"] }, verify("done")],
      edges: [{ id: "e", source: "route", target: "done", label: "success" }],
    };
    expect(codes(workflow)).toContain("ROUTE_OUTGOING_INCONSISTENT");
  });

  test("enforces join incoming shape and policy", () => {
    const workflow = {
      nodes: [agent("start"), { id: "join", kind: "join" }],
      edges: [{ id: "e", source: "start", target: "join" }],
    };
    const result = validateWorkflow(workflow);
    expect(codes(workflow)).toEqual(
      expect.arrayContaining(["JOIN_INCOMING_REQUIRED", "JOIN_POLICY_REQUIRED"]),
    );
    expect(result.valid).toBe(false);
  });

  test("counts distinct predecessor nodes for join quorum", () => {
    const workflow = {
      nodes: [
        agent("start"),
        verify("branch"),
        { id: "join", kind: "join", policy: "quorum", quorum: 2 },
        verify("done"),
      ],
      edges: [
        { id: "start-branch", source: "start", target: "branch" },
        { id: "branch-join-a", source: "branch", target: "join" },
        { id: "branch-join-b", source: "branch", target: "join" },
        { id: "start-join", source: "start", target: "join" },
        { id: "join-done", source: "join", target: "done" },
      ],
    };
    const result = validateWorkflow(workflow);
    expect(result.valid).toBe(true);
    expect(codes(workflow)).not.toContain("JOIN_POLICY_SHAPE_INVALID");
  });

  test("requires distinct predecessors rather than duplicate incoming edges", () => {
    const workflow = {
      nodes: [agent("start"), { id: "join", kind: "join", policy: "all" }, verify("done")],
      edges: [
        { id: "start-join-a", source: "start", target: "join" },
        { id: "start-join-b", source: "start", target: "join" },
        { id: "join-done", source: "join", target: "done" },
      ],
    };
    expect(codes(workflow)).toContain("JOIN_INCOMING_REQUIRED");
  });

  test.each([
    [
      "missing workflow input",
      (workflow: FixtureWorkflow) => {
        const inputBindings = fixtureNode(workflow, 0).inputBindings as FixtureRecord;
        (inputBindings.task as FixtureRecord).name = "missing";
      },
      "WORKFLOW_INPUT_REFERENCE_INVALID",
    ],
    [
      "missing node output target",
      (workflow: FixtureWorkflow) => {
        const inputBindings = fixtureNode(workflow, 0).inputBindings as FixtureRecord;
        inputBindings.task = {
          kind: "node_output",
          nodeId: "55555555-5555-4555-8555-555555555555",
        };
      },
      "NODE_OUTPUT_REFERENCE_TARGET_MISSING",
    ],
    [
      "self node output reference",
      (workflow: FixtureWorkflow) => {
        const inputBindings = fixtureNode(workflow, 0).inputBindings as FixtureRecord;
        inputBindings.task = {
          kind: "node_output",
          nodeId: fixtureNode(workflow, 0).id,
        };
      },
      "NODE_OUTPUT_REFERENCE_SELF",
    ],
    [
      "downstream node output reference",
      (workflow: FixtureWorkflow) => {
        const inputBindings = fixtureNode(workflow, 0).inputBindings as FixtureRecord;
        inputBindings.task = {
          kind: "node_output",
          nodeId: fixtureNode(workflow, 1).id,
        };
      },
      "NODE_OUTPUT_REFERENCE_NOT_UPSTREAM",
    ],
  ] as const)("rejects %s", async (_name, mutate, code) => {
    const workflow = await canonicalFixture();
    mutate(workflow);
    const result = compileWorkflow(workflow);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(code);
  });

  test("rejects a sibling node output reference even when it appears earlier in the node array", async () => {
    const workflow = await canonicalFixture();
    const start = fixtureNode(workflow, 0);
    const done = fixtureNode(workflow, 1);
    const left = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "agent",
      name: "Left",
      prompt: "Left branch",
      skills: [],
      inputBindings: {
        value: {
          kind: "node_output",
          nodeId: "66666666-6666-4666-8666-666666666666",
        },
      },
      requiredCapabilities: [],
      completionContract: "node_completion",
      tags: [],
    };
    const right = {
      ...left,
      id: "66666666-6666-4666-8666-666666666666",
      name: "Right",
      prompt: "Right branch",
      inputBindings: {},
    };
    workflow.nodes = [start, left, right, done];
    workflow.edges = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        source: start.id,
        target: left.id,
        metadata: {},
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        source: start.id,
        target: right.id,
        metadata: {},
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        source: left.id,
        target: done.id,
        metadata: {},
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        source: right.id,
        target: done.id,
        metadata: {},
      },
    ];

    const result = compileWorkflow(workflow);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "NODE_OUTPUT_REFERENCE_NOT_UPSTREAM",
    );
  });

  test("accepts a transitive strict-upstream node output reference", async () => {
    const workflow = await canonicalFixture();
    const start = fixtureNode(workflow, 0);
    const middle = fixtureNode(workflow, 1);
    const terminal = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "transform",
      name: "Collect result",
      operation: "pick",
      mapping: {
        result: {
          kind: "node_output",
          nodeId: start.id,
        },
      },
      tags: [],
    };
    workflow.nodes = [start, middle, terminal];
    workflow.edges = [
      { id: fixtureEdge(workflow, 0).id, source: start.id, target: middle.id, metadata: {} },
      {
        id: "66666666-6666-4666-8666-666666666666",
        source: middle.id,
        target: terminal.id,
        metadata: {},
      },
    ];

    const result = compileWorkflow(workflow);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NODE_OUTPUT_REFERENCE_NOT_UPSTREAM" }),
      ]),
    );
  });
});
