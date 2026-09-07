import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import { prepareWorkflowWorkspace } from "../src";

test("preparing a workspace preserves empty roots and resolves explicit restrictions", async () => {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-policy-"));
  try {
    const workflow = WorkflowDefinitionSchema.parse(
      await Bun.file(
        new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
      ).json(),
    );
    workflow.policies.workspace = {
      useGitWorktree: false,
      allowDirtyWorkspace: true,
      writableRoots: [],
    };
    const prepared = await prepareWorkflowWorkspace(workflow, project);
    expect(prepared.definition.policies.workspace.writableRoots).toEqual([]);
    expect(prepared.definition.policies.workspace.workingDirectory).toBe(project);
    workflow.policies.workspace.writableRoots = ["src", project, "/explicit/external"];
    const restricted = await prepareWorkflowWorkspace(workflow, project);
    expect(restricted.definition.policies.workspace.writableRoots).toEqual([
      resolve(project, "src"),
      project,
      "/explicit/external",
    ]);
    expect(workflow.policies.workspace.writableRoots).toEqual([
      "src",
      project,
      "/explicit/external",
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
