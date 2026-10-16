import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bundleLoopy,
  LocalExecutor,
  loadLoopy,
  localDaemon,
  openRunStore,
  Registry,
  SecretStore,
} from "../src/local/index.js";
import { prepareLaunch } from "../src/local/process.js";
import { CommandExecutionError } from "../src/runtime/index.js";
import { createLoopyRun } from "../src/sdk/host.js";

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
        workspace: { kind: "local", path: cwd },
        mode: "sandbox",
        sensitiveEnv: { SDK_TOKEN: "private-sdk-value" },
      },
    );

    expect(launch.program).toBe("/usr/bin/sandbox-exec");
    expect(launch.args.join(" ")).not.toContain("private-sdk-value");
    expect(launch.stdin).toContain("private-sdk-value");

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
      const printed = await command("pwd", { program: "/bin/pwd", args: [], cwd: "nested" });
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
  const registry = new Registry(home, cwd);
  registry.save(loopy, { source, bundleHash: bundle.hash });
  const store = openRunStore(home);

  try {
    await createLoopyRun({
      loopy,
      input: {},
      store,
      workspace: cwd,
      runId: "queued",
      bundleHash: bundle.hash,
    });
    new SecretStore(home).set("SDK_TOKEN", "resolved-at-activation");

    registry.save(await loadLoopy(changed.path), { source, bundleHash: changed.hash });
    expect(changed.hash).not.toBe(bundle.hash);
    rmSync(source);
    const errors: string[] = [];

    const daemon = localDaemon({
      home,
      cwd: directory(),
      store,
      onError: (error) => errors.push(error.message),
    });

    expect(await daemon.tick()).toEqual({ fired: 0, activated: 1 });
    await daemon.stop();
    expect(errors).toEqual([]);
    expect(await store.getRun("queued")).toMatchObject({
      status: "succeeded",
      output: expect.stringMatching(/\/nested\n$/),
      bundleHash: bundle.hash,
    });
    expect(await store.getSteps("queued")).toMatchObject([
      { key: "pwd", kind: "command" },
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
  new Registry(home, cwd).save(await loadLoopy(bundle.path), { source, bundleHash: bundle.hash });
  const store = openRunStore(home);
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

for (const missing of ["secret", "bundle"]) {
  test(`daemon fails a run with a missing ${missing} once and releases its owner`, async () => {
    const cwd = directory();
    const home = directory();
    const source = join(cwd, "missing.loopy.ts");
    const sdk = resolve(import.meta.dir, "../src/sdk/index.ts");
    await Bun.write(
      source,
      `import { loopy } from ${JSON.stringify(sdk)};
      export default loopy({ name: "missing", secrets: ["ABSENT_TOKEN"], run: () => 1 });`,
    );
    const bundle = await bundleLoopy(source, home);
    const loopy = await loadLoopy(bundle.path);
    const store = openRunStore(home);
    const errors: { message: string; runId?: string }[] = [];

    const daemon = localDaemon({
      home,
      cwd,
      store,
      onError: (error, run) => errors.push({ message: error.message, runId: run?.id }),
    });

    try {
      await createLoopyRun({
        loopy,
        input: {},
        store,
        runId: "missing",
        bundleHash: bundle.hash,
        workspace: cwd,
      });

      if (missing === "bundle") {
        rmSync(bundle.path);
      }

      expect(await daemon.tick()).toEqual({ fired: 0, activated: 1 });
      expect(await store.getRun("missing")).toMatchObject({
        status: "failed",
        error: expect.any(String),
      });
      expect((await store.getRun("missing"))?.owner).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.runId).toBe("missing");
      expect(errors[0]?.message).toContain(
        missing === "secret" ? "ABSENT_TOKEN" : "Missing bundle",
      );
      expect(await daemon.tick()).toEqual({ fired: 0, activated: 0 });
      expect(errors).toHaveLength(1);
    } finally {
      await daemon.stop();
      store.close();
    }
  });
}
