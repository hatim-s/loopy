import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SecretStore } from "../src/local/index.js";
import { prepareLaunch } from "../src/local/process.js";
import { CommandExecutionError } from "../src/runtime/index.js";

const roots: string[] = [];

function directory() {
  const root = mkdtempSync(join(tmpdir(), "loopy-local-executor-"));
  roots.push(root);

  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalExecutor runs printf in full mode with literal arguments", async () => {
  const cwd = directory();

  const result = await new LocalExecutor({ home: directory(), secrets: [] }).execute(
    { program: "printf", args: ["%s", "hello ; $HOME"] },
    { workspace: cwd, mode: "full" },
  );

  expect(result.stdout).toBe("hello ; $HOME");
  expect(result.exitCode).toBe(0);
});

test.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "LocalExecutor runs printf in the macOS sandbox and keeps secrets off argv",
  async () => {
    const cwd = directory();
    const home = directory();
    new SecretStore(home).set("SDK_TOKEN", "private-sdk-value");

    const launch = await prepareLaunch(
      { program: "printf", args: ["hello"] },
      {
        workspace: cwd,
        mode: "sandbox",
        sensitiveEnv: { SDK_TOKEN: "private-sdk-value" },
      },
    );

    expect(launch.program).toBe("/usr/bin/sandbox-exec");
    expect(launch.args.join(" ")).not.toContain("private-sdk-value");
    expect(launch.stdin).toContain("private-sdk-value");

    if (launch.scratch) {
      rmSync(launch.scratch, { recursive: true, force: true });
    }

    const result = await new LocalExecutor({ home, secrets: ["SDK_TOKEN"] }).execute(
      { program: "/bin/sh", args: ["-c", 'printf %s "$SDK_TOKEN"'] },
      { workspace: cwd, mode: "sandbox" },
    );

    expect(result.stdout).toBe("[redacted]");
  },
);

test("sensitive env is available to commands and redacted from output and errors", async () => {
  const home = directory();
  new SecretStore(home).set("SDK_TOKEN", "private-sdk-value");
  const executor = new LocalExecutor({ home, secrets: ["SDK_TOKEN"] });

  const options = { workspace: directory(), mode: "full" } satisfies Parameters<
    LocalExecutor["execute"]
  >[1];

  const result = await executor.execute(
    { program: "/bin/sh", args: ["-c", 'printf "%s" "$SDK_TOKEN"'] },
    options,
  );

  expect(result.stdout).toBe("[redacted]");

  const failed = await executor.execute(
    { program: "/bin/sh", args: ["-c", 'printf "%s" "$SDK_TOKEN" >&2; exit 2'] },
    options,
  );

  expect(failed).toMatchObject({ exitCode: 2, stderr: "[redacted]" });
  await expect(
    executor.execute(
      { program: "/bin/sh", args: ["-c", 'printf "%s" "$SDK_TOKEN"; sleep 5'] },
      { ...options, timeoutMs: 100 },
    ),
  ).rejects.toBeInstanceOf(CommandExecutionError);
});

test.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "sandboxed git status leaves the workspace clean",
  async () => {
    const cwd = directory();
    const executor = new LocalExecutor({ home: directory(), secrets: [] });
    mkdirSync(join(cwd, "repo"));

    expect(
      (
        await executor.execute(
          { program: "git", args: ["init", "-q"], cwd: "repo" },
          { workspace: cwd, mode: "full" },
        )
      ).exitCode,
    ).toBe(0);

    const result = await executor.execute(
      { program: "/usr/bin/git", args: ["status", "--porcelain"], cwd: "repo" },
      { workspace: cwd, mode: "sandbox" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(readdirSync(cwd)).toEqual(["repo"]);
    expect(readdirSync(join(cwd, "repo"))).toEqual([".git"]);
  },
);

test.skipIf(process.platform !== "darwin")(
  "sandbox scratch is writable and removed after execution",
  async () => {
    const cwd = directory();

    const result = await new LocalExecutor({ home: directory(), secrets: [] }).execute(
      {
        program: "/bin/sh",
        args: ["-c", 'touch "$HOME/cache" "$TMPDIR/temp"; printf "%s" "$HOME"'],
      },
      { workspace: cwd, mode: "sandbox" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe(cwd);
    expect(result.stdout).toContain("loopy-run-");
    expect(existsSync(result.stdout)).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  },
);
