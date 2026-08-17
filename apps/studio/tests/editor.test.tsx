// @vitest-environment jsdom

import type { VerifyNode } from "@loopy/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  diagnosticsFor,
  fallbackWorkflow,
  toFlowEdges,
  toFlowNodes,
  VerifyFields,
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

  domIt("edits the selected verification command while preserving sibling commands", () => {
    const node: VerifyNode = {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "verify",
      name: "Verify",
      commands: [
        { command: "bun", args: ["test"], timeoutMs: 120000 },
        { command: "bun", args: ["run", "lint"], timeoutMs: 120000 },
      ],
      success: "all",
      expectedExitCode: 0,
      tags: [],
    };
    const updates: Array<Partial<VerifyNode>> = [];
    render(<VerifyFields node={node} update={(patch) => updates.push(patch)} />);
    fireEvent.change(screen.getByLabelText("Command to edit"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "pnpm" } });
    expect(updates.at(-1)?.commands).toEqual([
      { command: "bun", args: ["test"], timeoutMs: 120000 },
      { command: "pnpm", args: ["run", "lint"], timeoutMs: 120000 },
    ]);
  });
});
