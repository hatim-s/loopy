import { expect, test } from "bun:test";
import { createToolRegistry } from "../src/index";
import type { InstallOutcome } from "../src/process";

const ok: InstallOutcome = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

test("installs only catalog argv and verifies discovery after installation", async () => {
  const binaries = new Map([["bun", "/test/bin/bun"]]);
  const calls: string[][] = [];
  const registry = createToolRegistry({
    which: (name) => binaries.get(name) ?? null,
    run: async (argv) => {
      calls.push(argv);
      binaries.set("codex", "/test/bin/codex");
      return ok;
    },
  });
  expect(registry.list().find((tool) => tool.id === "codex")).toMatchObject({
    installed: false,
    install: { available: true, command: "bun add --global @openai/codex" },
  });
  expect(await registry.install("codex")).toMatchObject({
    tool: { installed: true },
    alreadyInstalled: false,
  });
  expect(calls).toEqual([["/test/bin/bun", "add", "--global", "@openai/codex"]]);
  expect(await registry.install("codex")).toMatchObject({ alreadyInstalled: true });
  expect(calls).toHaveLength(1);
  await expect(registry.install("codex; touch unexpected")).rejects.toMatchObject({
    code: "unknown_tool",
  });
});
test("serializes installers and releases its slot on failure", async () => {
  let release: (value: InstallOutcome) => void = () => {};
  const registry = createToolRegistry({
    which: (name) => (name === "bun" ? "/bin/bun" : null),
    run: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = registry.install("codex");
  await expect(registry.install("claude")).rejects.toMatchObject({ code: "install_busy" });
  release({ ...ok, exitCode: 1 });
  await expect(pending).rejects.toMatchObject({ code: "install_failed" });
  const retry = registry.install("claude");
  release(ok);
  await expect(retry).rejects.toMatchObject({ code: "verification_failed" });
});
test("reports unavailable installers and platform restrictions without spawning", async () => {
  let calls = 0;
  const registry = createToolRegistry({
    platform: "linux",
    which: (name) => (name === "brew" ? "/bin/brew" : null),
    run: async () => {
      calls++;
      return ok;
    },
  });
  await expect(registry.install("slack")).rejects.toMatchObject({ code: "installer_unavailable" });
  await expect(registry.install("codex")).rejects.toMatchObject({ code: "installer_unavailable" });
  expect(calls).toBe(0);
});

test("the Bun installer runner drains output without retaining an unbounded log", async () => {
  const { runInstaller } = await import("../src/process");
  const result = await runInstaller(
    [
      process.execPath,
      "-e",
      "process.stdout.write('x'.repeat(200000)); process.stderr.write('done')",
    ],
    process.cwd(),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(128_000);
});
