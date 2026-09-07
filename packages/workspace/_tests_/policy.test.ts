import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a subdirectory project retains its directory and explicit roots in the repository worktree", async () => {
  const repository = mkdtempSync(resolve(tmpdir(), "loopy-policy-subdir-"));
  const project = resolve(repository, "packages/app");
  let prepared: Awaited<ReturnType<typeof prepareWorkflowWorkspace>> | undefined;
  try {
    mkdirSync(resolve(project, "src"), { recursive: true });
    writeFileSync(resolve(project, "src/index.ts"), "export {};\n");
    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "."],
      [
        "-c",
        "user.name=Loopy Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      expect(
        Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" })
          .exitCode,
      ).toBe(0);
    }
    const workflow = WorkflowDefinitionSchema.parse(
      await Bun.file(
        new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
      ).json(),
    );
    workflow.policies.workspace = {
      useGitWorktree: true,
      allowDirtyWorkspace: false,
      writableRoots: [project, "src", repository, "/explicit/external"],
    };
    prepared = await prepareWorkflowWorkspace(workflow, project);
    const isolatedRepository = resolve(prepared.workingDirectory, "../..");
    expect(prepared.workingDirectory).toBe(resolve(isolatedRepository, "packages/app"));
    expect(prepared.definition.policies.workspace.writableRoots).toEqual([
      resolve(isolatedRepository, "packages/app"),
      resolve(isolatedRepository, "packages/app/src"),
      isolatedRepository,
      "/explicit/external",
    ]);
    expect(await Bun.file(resolve(prepared.workingDirectory, "src/index.ts")).text()).toBe(
      "export {};\n",
    );
    await prepared.cleanup();
    prepared = undefined;
    workflow.policies.workspace.workingDirectory = "src";
    prepared = await prepareWorkflowWorkspace(workflow, project);
    expect(prepared.workingDirectory.endsWith("/packages/app/src")).toBe(true);
    expect(await Bun.file(resolve(prepared.workingDirectory, "index.ts")).text()).toBe(
      "export {};\n",
    );
    expect(workflow.policies.workspace.workingDirectory).toBe("src");
  } finally {
    await prepared?.cleanup();
    rmSync(repository, { recursive: true, force: true });
  }
});
