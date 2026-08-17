// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  diagnosticsFor,
  fallbackWorkflow,
  toFlowEdges,
  toFlowNodes,
  WorkflowNodeCard,
} from "../src/features/editor";

const domIt = typeof document === "undefined" ? it.skip : it;

describe("workflow editor model", () => {
  it("projects every contract node and edge into an editable graph", () => {
    const workflow = fallbackWorkflow("11111111-1111-4111-8111-111111111111");
    const nodes = toFlowNodes(workflow);
    const edges = toFlowEdges(workflow);

    expect(nodes).toHaveLength(workflow.nodes.length);
    expect(edges).toHaveLength(workflow.edges.length);
    expect(nodes[0]?.data.workflowNode.kind).toBe("agent");
    expect(edges[0]?.source).toBe(workflow.edges[0]?.source);
  });

  it("reports graph errors without claiming a malformed workflow is runnable", () => {
    const workflow = fallbackWorkflow("11111111-1111-4111-8111-111111111111");
    const invalid = {
      ...workflow,
      name: "",
      nodes: [],
      edges: [
        {
          ...(workflow.edges[0] as NonNullable<(typeof workflow.edges)[number]>),
          source: "22222222-2222-4222-8222-222222222222",
        },
      ],
    };

    expect(diagnosticsFor(invalid).map((item) => item.path)).toEqual(
      expect.arrayContaining(["name", "nodes", "edges"]),
    );
  });

  domIt("keeps custom nodes named and keyboard discoverable", () => {
    const workflow = fallbackWorkflow("11111111-1111-4111-8111-111111111111");
    const node = workflow.nodes[0];
    if (!node) throw new Error("fixture did not contain an agent node");
    render(
      <ReactFlowProvider>
        <WorkflowNodeCard data={{ workflowNode: node }} />
      </ReactFlowProvider>,
    );

    expect(screen.getByRole("button", { name: "Agent step agent node" })).toBeTruthy();
    expect(screen.getByText("agent")).toBeTruthy();
  });
});
