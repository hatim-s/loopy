import { describe, expect, test } from "bun:test";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import { compileWorkflow, validateWorkflow } from "../src/index.ts";

const agent = (id: string, prompt = "Do the work") => ({ id, kind: "agent", prompt });
const verify = (id: string) => ({ id, kind: "verify", commands: ["bun test"] });

function codes(workflow: unknown): string[] {
  return validateWorkflow(workflow).diagnostics.map((item) => item.code);
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
      edges: [{ id: "e", source: "route", target: "done", condition: "success" }],
    };
    const result = validateWorkflow(workflow);
    expect(codes(workflow)).toContain("ROUTE_LABEL_REQUIRED");
    expect(result.graph.edges[0]?.route).toBeUndefined();
    expect(result.graph.edges[0]?.condition).toBe("success");
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
});
