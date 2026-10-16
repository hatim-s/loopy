import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bundleLoopy,
  LocalExecutor,
  Loopies,
  loadLoopy,
  localDaemon,
  openEngineStore,
  SecretStore,
} from "../src/local/index.js";
import { prepareLaunch } from "../src/local/process.js";
import { CommandExecutionError, CommandExitError } from "../src/runtime/index.js";
import { startLoopy } from "../src/sdk/index.js";

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

  const result = await new LocalExecutor().execute(
    { program: "printf", args: ["%s", "hello ; $HOME"] },
    { cwd, mode: "full" },
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
        workspace: { kind: "local", path: cwd },
        mode: "sandbox",
        sensitiveEnv: { SDK_TOKEN: "private-sdk-value" },
      },
    );

    expect(launch.program).toBe("/usr/bin/sandbox-exec");
    expect(launch.args.join(" ")).not.toContain("private-sdk-value");
    expect(launch.stdin).toContain("private-sdk-value");

    const result = await new LocalExecutor(home, ["SDK_TOKEN"]).execute(
      { program: "printf", args: ["hello"] },
      { cwd, mode: "sandbox" },
    );

    expect(result.stdout).toBe("hello");
  },
);

test("nonzero exit becomes CommandExitError carrying command output", async () => {
  const executor = new LocalExecutor();

  try {
    await executor.execute(
      { program: "/bin/sh", args: ["-c", "printf problem >&2; exit 7"] },
      { cwd: directory(), mode: "full" },
    );
    throw new Error("Expected the command to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(CommandExitError);

    if (!(error instanceof CommandExitError)) {
      throw error;
    }

    expect(error.output.exitCode).toBe(7);
    expect(error.output.stderr).toBe("problem");
  }
});

test("timeout kills the real child and its descendants", async () => {
  const cwd = directory();
  await expect(
    new LocalExecutor().execute(
      { program: "/bin/sh", args: ["-c", "(sleep 0.4; touch survived) & wait"], timeoutMs: 100 },
      { cwd, mode: "full" },
    ),
  ).rejects.toThrow("timed out");
  await Bun.sleep(600);
  expect(existsSync(join(cwd, "survived"))).toBe(false);
});

test("sensitive env is available to commands and redacted from output and errors", async () => {
  const home = directory();
  new SecretStore(home).set("SDK_TOKEN", "private-sdk-value");
  const executor = new LocalExecutor(home, ["SDK_TOKEN"]);

  const options = { cwd: directory(), mode: "full" } satisfies Parameters<
    LocalExecutor["execute"]
  >[1];

  const result = await executor.execute(
    { program: "/bin/sh", args: ["-c", 'printf "%s" "$SDK_TOKEN"'] },
    options,
  );

  expect(result.stdout).toBe("[redacted]");
  await expect(
    executor.execute(
      { program: "/bin/sh", args: ["-c", 'printf "%s" "$SDK_TOKEN" >&2; exit 2'] },
      options,
    ),
  ).rejects.toThrow("[redacted]");
  await expect(
    executor.execute(
      { program: "/bin/sh", args: ["-c", 'printf "%s" "$SDK_TOKEN"; sleep 5'], timeoutMs: 100 },
      options,
    ),
  ).rejects.toBeInstanceOf(CommandExecutionError);
});

test("Daemon.tick executes a bundled SDK command with activation-time secrets and the original bundle", async () => {
  const cwd = directory();
  const home = directory();
  mkdirSync(join(cwd, "nested"));
  const source = join(cwd, "queued.loopy.ts");
  const sdk = resolve(import.meta.dir, "../src/sdk/index.ts");
  await Bun.write(
    source,
    `import { loopy, command, step } from ${JSON.stringify(sdk)};
    export default loopy({ name: "queued", mode: "full", secrets: ["SDK_TOKEN"], run: async () => {
      const printed = await command("printf", { program: "printf", args: ["%s", "daemon hello"], cwd: "nested" });
      await command("secret", { program: "/bin/sh", args: ["-c", 'printf "%s" "$SDK_TOKEN" > token'] });
      return step("answer", () => printed.stdout);
    }});`,
  );
  const bundle = await bundleLoopy(source, home);
  await Bun.write(
    source,
    `import { loopy } from ${JSON.stringify(sdk)};
    export default loopy({ name: "queued", mode: "sandbox", run: () => 99 });`,
  );
  const changed = await bundleLoopy(source, home);
  const loopy = await loadLoopy(bundle.path);
  const registry = new Loopies(home, cwd);
  registry.save(loopy, source, bundle.hash);
  const store = openEngineStore(home);

  try {
    await startLoopy({
      loopy,
      input: {},
      store,
      executor: new LocalExecutor(),
      cwd,
      runId: "queued",
      bundleHash: bundle.hash,
      detach: true,
    });
    new SecretStore(home).set("SDK_TOKEN", "resolved-at-activation");

    registry.save(await loadLoopy(changed.path), source, changed.hash);
    expect(changed.hash).not.toBe(bundle.hash);
    rmSync(source);
    const errors: string[] = [];

    const daemon = localDaemon({
      home,
      cwd,
      store,
      onError: (error) => errors.push(error.message),
    });

    expect(await daemon.tick()).toEqual({ fired: 0, activated: 1 });
    await daemon.stop();
    expect(errors).toEqual([]);
    expect(await store.getRun("queued")).toMatchObject({
      status: "succeeded",
      output: "daemon hello",
      bundleHash: bundle.hash,
    });
    expect(await store.getSteps("queued")).toMatchObject([
      { key: "printf", kind: "command" },
      { key: "secret" },
      { key: "answer", kind: "function" },
    ]);
    expect(readFileSync(join(cwd, "token"), "utf8")).toBe("resolved-at-activation");
  } finally {
    store.close();
  }
});

test("Daemon.tick pins the registry bundle when a schedule creates a run", async () => {
  const cwd = directory();
  const home = directory();
  const source = join(cwd, "scheduled.loopy.ts");
  const sdk = resolve(import.meta.dir, "../src/sdk/index.ts");
  await Bun.write(
    source,
    `import { loopy, step } from ${JSON.stringify(sdk)};
    export default loopy({ name: "scheduled", run: () => step("answer", () => 42) });`,
  );
  const bundle = await bundleLoopy(source, home);
  new Loopies(home, cwd).save(await loadLoopy(bundle.path), source, bundle.hash);
  const store = openEngineStore(home);
  const daemon = localDaemon({ home, cwd, store });

  try {
    await store.putSchedule({
      slug: "scheduled",
      cron: "* * * * *",
      tz: "UTC",
      input: {},
      enabled: true,
      nextFireAt: new Date().toISOString(),
    });
    expect(await daemon.tick()).toEqual({ fired: 1, activated: 1 });
    expect(await store.listRuns()).toMatchObject([
      { bundleHash: bundle.hash, status: "succeeded", output: 42 },
    ]);
    expect(await daemon.tick()).toEqual({ fired: 0, activated: 0 });
  } finally {
    await daemon.stop();
    store.close();
  }
});
