import { describe, expect, test } from "bun:test";
import { compileWorkflow, validateWorkflow } from "../src/index.ts";
import type { WorkflowDefinition } from "../src/index.ts";

const agent = (id: string, prompt = "Do the work") => ({ id, kind: "agent", prompt });
const verify = (id: string) => ({ id, kind: "verify", commands: ["bun test"] });

function codes(workflow: unknown): string[] {
  return validateWorkflow(workflow).diagnostics.map((item) => item.code);
}

describe("workflow graph validation", () => {
  test("accepts a linear workflow and prepares a normalized plan", () => {
    const workflow: WorkflowDefinition = {
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
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.plan.kind).toBe("normalized-execution-plan");
  });

  test("accepts the checked-in branch/join fixture", async () => {
    const fixture = await Bun.file(new URL("../../../fixtures/workflows/validation/valid-branch-join.json", import.meta.url)).json();
    const result = validateWorkflow(fixture);
    expect(result.valid).toBe(true);
    expect(result.graph.terminalNodeIds).toEqual(["approve"]);
  });

  test("reports the checked-in invalid fixture", async () => {
    const fixture = await Bun.file(new URL("../../../fixtures/workflows/validation/invalid-route-cycle.json", import.meta.url)).json();
    expect(codes(fixture)).toEqual(expect.arrayContaining(["ROUTE_LABEL_REQUIRED", "JOIN_INCOMING_REQUIRED", "CYCLE_UNSUPPORTED"]));
  });

  test.each([
    ["duplicate node ids", { nodes: [agent("a"), agent("a")], edges: [] }, "DUPLICATE_NODE_ID"],
    ["duplicate edge ids", { nodes: [agent("a"), verify("b")], edges: [{ id: "e", source: "a", target: "b" }, { id: "e", source: "a", target: "b" }] }, "DUPLICATE_EDGE_ID"],
    ["missing endpoint", { nodes: [agent("a")], edges: [{ id: "e", source: "a", target: "missing" }] }, "EDGE_ENDPOINT_MISSING"],
    ["cycle", { nodes: [agent("a"), verify("b")], edges: [{ id: "ab", source: "a", target: "b" }, { id: "ba", source: "b", target: "a" }] }, "CYCLE_UNSUPPORTED"],
    ["unreachable subgraph", { nodes: [agent("a"), verify("b"), verify("orphan")], edges: [{ id: "ab", source: "a", target: "b" }] }, "DISCONNECTED_SUBGRAPH"],
    ["missing terminal", { nodes: [agent("a"), verify("b")], edges: [{ id: "ab", source: "a", target: "b" }, { id: "ba", source: "b", target: "a" }] }, "NO_REACHABLE_TERMINAL"],
  ] as const)("reports %s", (_name, workflow, code) => {
    expect(codes(workflow)).toContain(code);
  });

  test("reports exact JSON pointer paths for malformed fields", () => {
    const result = validateWorkflow({
      nodes: [{ id: "start", kind: "agent" }],
      edges: [{ id: "e", source: "start", target: "missing" }],
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NODE_REQUIRED_FIELD", path: "/nodes/0/prompt", pathSegments: ["nodes", 0, "prompt"] }),
      expect.objectContaining({ code: "EDGE_ENDPOINT_MISSING", path: "/edges/0/target", pathSegments: ["edges", 0, "target"] }),
    ]));
  });

  test("requires labelled, unique route edges", () => {
    const workflow = {
      nodes: [{ id: "route", kind: "route" }, verify("done-a"), verify("done-b")],
      edges: [
        { id: "a", source: "route", target: "done-a", route: "same" },
        { id: "b", source: "route", target: "done-b", route: "same" },
      ],
    };
    expect(codes(workflow)).toContain("ROUTE_LABEL_DUPLICATE");
  });

  test("checks optional route declarations against outgoing labels", () => {
    const workflow = {
      nodes: [{ id: "route", kind: "route", routes: ["success", "failure"] }, verify("done")],
      edges: [{ id: "e", source: "route", target: "done", route: "success" }],
    };
    expect(codes(workflow)).toContain("ROUTE_OUTGOING_INCONSISTENT");
  });

  test("enforces join incoming shape and policy", () => {
    const workflow = { nodes: [agent("start"), { id: "join", kind: "join" }], edges: [{ id: "e", source: "start", target: "join" }] };
    const result = validateWorkflow(workflow);
    expect(codes(workflow)).toEqual(expect.arrayContaining(["JOIN_INCOMING_REQUIRED", "JOIN_POLICY_REQUIRED"]));
    expect(result.valid).toBe(false);
  });
});
