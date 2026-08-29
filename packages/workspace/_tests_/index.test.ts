import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorkspace, createShellVerifier } from "../src/index.ts";

const temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      new TextDecoder().decode(result.stderr) || new TextDecoder().decode(result.stdout),
    );
}

function repository(): string {
  const path = temporaryDirectory("loopy-workspace-test-");
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Loopy Test");
  git(path, "config", "user.email", "loopy@example.test");
  writeFileSync(join(path, "README.md"), "# test\n");
  git(path, "add", "README.md");
  git(path, "commit", "-m", "Initial commit");
  return path;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workflow workspaces", () => {
  test("creates and removes a clean detached Git worktree", async () => {
    const root = repository();
    const workspace = await createGitWorkspace(root);
    expect(workspace.path).not.toBe(root);
    expect(existsSync(join(workspace.path, "README.md"))).toBe(true);

    const cleanup = await workspace.cleanup();
    expect(cleanup.removed).toBe(true);
    expect(existsSync(workspace.path)).toBe(false);
  });

  test("retains a dirty run worktree for inspection", async () => {
    const root = repository();
    const workspace = await createGitWorkspace(root);
    writeFileSync(join(workspace.path, "result.txt"), "inspect me\n");

    const cleanup = await workspace.cleanup();
    expect(cleanup).toMatchObject({ removed: false, path: workspace.path });
    expect(existsSync(join(workspace.path, "result.txt"))).toBe(true);

    git(root, "worktree", "remove", "--force", workspace.path);
  });

  test("executes argv verification commands and rejects cwd escapes", async () => {
    const root = temporaryDirectory("loopy-verifier-test-");
    const verifier = createShellVerifier({ workingDirectory: root });
    const base = {
      runId: "run",
      attemptId: "attempt",
      nodeId: "verify",
      input: {},
    };

    await expect(
      verifier.verify({
        ...base,
        node: {
          id: "verify",
          kind: "verify",
          commands: [{ command: "bun", args: ["-e", "process.exit(0)"] }],
        },
      }),
    ).resolves.toMatchObject({ status: "passed" });
    await expect(
      verifier.verify({
        ...base,
        node: {
          id: "verify",
          kind: "verify",
          commands: [{ command: "bun", args: ["-e", "process.exit(3)"] }],
        },
      }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      verifier.verify({
        ...base,
        node: {
          id: "verify",
          kind: "verify",
          commands: [{ command: "bun", cwd: ".." }],
        },
      }),
    ).rejects.toThrow(/escapes the run workspace/);
  });
});
