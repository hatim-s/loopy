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

test("Git workspace preparation rebases only explicit roots inside the project", async () => {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-policy-git-"));
  let prepared: Awaited<ReturnType<typeof prepareWorkflowWorkspace>> | undefined;
  try {
    for (const args of [
      ["init", "--initial-branch=main"],
      [
        "-c",
        "user.name=Loopy Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
    ]) {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    }
    const workflow = WorkflowDefinitionSchema.parse(
      await Bun.file(
        new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
      ).json(),
    );
    workflow.policies.workspace = {
      useGitWorktree: true,
      allowDirtyWorkspace: false,
      writableRoots: [project, resolve(project, "src"), "/explicit/external"],
    };
    prepared = await prepareWorkflowWorkspace(workflow, project);
    expect(prepared.definition.policies.workspace.writableRoots).toEqual([
      prepared.workingDirectory,
      resolve(prepared.workingDirectory, "src"),
      "/explicit/external",
    ]);
    expect(workflow.policies.workspace.writableRoots).toEqual([
      project,
      resolve(project, "src"),
      "/explicit/external",
    ]);
  } finally {
    await prepared?.cleanup();
    rmSync(project, { recursive: true, force: true });
  }
});
