import { join } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import { describe, expect, test } from "vitest";
import { applyWorkflowPatch, WorkflowEditError, workflowVersionDiff } from "../src/workflow-edit";

const fixture = WorkflowDefinitionSchema.parse(
  await Bun.file(join(import.meta.dir, "../../../fixtures/workflows/valid-basic.json")).json(),
);

describe("workflow edit contracts", () => {
  test("diffs semantic collections by stable node, edge, and input keys", () => {
    const after = structuredClone(fixture);
    after.workflowVersion = 2;
    const firstNode = after.nodes[0];
    if (!firstNode) throw new Error("fixture requires a node");
    const addedNode = structuredClone(firstNode);
    addedNode.id = "55555555-5555-4555-8555-555555555555";
    after.nodes.unshift(addedNode);
    const firstEdge = after.edges[0];
    if (!firstEdge) throw new Error("fixture requires an edge");
    const addedEdge = structuredClone(firstEdge);
    addedEdge.id = "66666666-6666-4666-8666-666666666666";
    after.edges.unshift(addedEdge);
    after.inputs.unshift({
      name: "workspace",
      type: "string",
      required: false,
      secret: false,
    });

    const diff = workflowVersionDiff(fixture.id, 1, 2, fixture, after);
    expect(diff.changed).toBe(true);
    expect(diff.changes.map((change) => change.path)).toEqual([
      "/edges/66666666-6666-4666-8666-666666666666",
      "/inputs/workspace",
      "/nodes/55555555-5555-4555-8555-555555555555",
      "/workflowVersion",
    ]);
  });

  test("rejects a patch whose base version does not match the input workflow", () => {
    expect(() =>
      applyWorkflowPatch(fixture, {
        schemaVersion: "1",
        workflowId: fixture.id,
        baseVersion: 2,
        operations: [{ op: "set_workflow_name", name: "stale" }],
      }),
    ).toThrow(WorkflowEditError);
    try {
      applyWorkflowPatch(fixture, {
        schemaVersion: "1",
        workflowId: fixture.id,
        baseVersion: 2,
        operations: [{ op: "set_workflow_name", name: "stale" }],
      });
    } catch (error) {
      expect((error as WorkflowEditError).diagnostic).toMatchObject({
        code: "WORKFLOW_VERSION_MISMATCH",
        path: "/baseVersion",
      });
    }
  });
});
