import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, trigger } from "../src/core/index.js";
import type { ExecuteCommand, ExecutionMode } from "../src/core/model.js";
import { localRunOptions } from "../src/local/process.js";
import { Registry } from "../src/local/registry.js";
import { createLocalRuntime } from "../src/local/runtime.js";
import { secretRedactor } from "../src/local/secret-executor.js";
import { SecretStore } from "../src/local/secrets.js";
import { CommandExecutionError } from "../src/runtime/errors.js";

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "loopy-bindings-"));
  directories.push(directory);
  const home = join(directory, "home");
  const cwd = join(directory, "workspace");
  mkdirSync(cwd);
  const registry = new Registry(home, cwd);
  const secrets = new SecretStore(home);
  secrets.set("shared-cookie", "private-cookie-first");
  const workflow = trigger("secret-probe")
    .config({ scope: "global" })
    .node("probe", command(process.execPath, "-e", "console.log(process.env.LOOPY_BOUND_COOKIE)"))
    .build();
  const source = join(directory, "source.loopy.ts");
  registry.save(workflow, source);
  registry.bindSecret(workflow.slug, "LOOPY_BOUND_COOKIE", "shared-cookie");
  return { directory, home, cwd, registry, secrets, workflow, source };
}
afterEach(() => {
  delete process.env.LOOPY_BOUND_COOKIE;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("bindings retain identity for their source and clear on slug transfer", () => {
  const { registry, workflow, source, directory } = setup();
  const original = registry.get(workflow.slug).secretBindings;
  expect(original?.env).toEqual({ LOOPY_BOUND_COOKIE: "shared-cookie" });
  registry.save(workflow, source, { replace: true });
  expect(registry.get(workflow.slug).secretBindings).toEqual(original);
  registry.save(workflow, join(directory, "other.ts"), { replace: true });
  expect(registry.get(workflow.slug).secretBindings).toBeUndefined();
  registry.bindSecret(workflow.slug, "LOOPY_BOUND_COOKIE", "shared-cookie");
  expect(registry.get(workflow.slug).secretBindings?.ownerId).not.toBe(original?.ownerId);
});

test("binding edits share the workflow save lock", () => {
  const { registry, home, workflow } = setup();
  mkdirSync(join(home, "workflows", `${workflow.slug}.json.lock`));
  expect(() => registry.unbindSecret(workflow.slug, "LOOPY_BOUND_COOKIE")).toThrow(
    "Another save holds",
  );
  expect(registry.get(workflow.slug).secretBindings?.env).toEqual({
    LOOPY_BOUND_COOKIE: "shared-cookie",
  });
});

test("a bound secret reaches commands but never run checkpoints or events", async () => {
  const { home, cwd, registry, workflow } = setup();
  const local = createLocalRuntime({ home });
  try {
    const saved = registry.get(workflow.slug);
    const run = await local.runtime.createRun(
      saved.workflow,
      {},
      { ...localRunOptions(cwd, "full"), secretBindings: saved.secretBindings },
    );
    expect((await local.runtime.execute(run.id)).status).toBe("succeeded");
    const attempts = await local.runtime.getAttempts(run.id);
    expect(attempts[0]?.output).toMatchObject({ stdout: "[redacted]\n" });
    const checkpoint = JSON.stringify({
      run: await local.runtime.getRun(run.id),
      attempts,
      events: await local.runtime.getEvents(run.id),
    });
    expect(checkpoint).not.toContain("private-cookie-first");
    expect(checkpoint).toContain("shared-cookie");
    expect(attempts[0]?.input).not.toHaveProperty("env");
  } finally {
    local.close();
  }
});

test("resume rereads a rotated secret and skips successful steps", async () => {
  const { home, cwd, registry, secrets, workflow, source } = setup();
  const seen: string[] = [];
  const executor: ExecuteCommand = async (cmd) => {
    seen.push(cmd.env?.LOOPY_BOUND_COOKIE ?? "missing");
    return {
      stdout: cmd.env?.LOOPY_BOUND_COOKIE ?? "",
      stderr: "",
      exitCode: seen.length === 2 ? 7 : 0,
      durationMs: 0,
    };
  };
  const local = createLocalRuntime({ home, executor });
  try {
    const twoSteps = {
      ...workflow,
      nodes: [
        { id: "probe", kind: "command" as const, command: command("echo", "first") },
        { id: "second", kind: "command" as const, command: command("echo", "second") },
      ],
    };
    registry.save(twoSteps, source);
    const saved = registry.get(workflow.slug);
    const run = await local.runtime.createRun(
      saved.workflow,
      {},
      { ...localRunOptions(cwd, "full"), secretBindings: saved.secretBindings },
    );
    expect((await local.runtime.execute(run.id)).status).toBe("failed");
    secrets.set("shared-cookie", "private-cookie-rotated");
    expect((await local.runtime.execute(run.id)).status).toBe("succeeded");
    expect(seen).toEqual([
      "private-cookie-first",
      "private-cookie-first",
      "private-cookie-rotated",
    ]);
    const stored = JSON.stringify(await local.runtime.getAttempts(run.id));
    expect(stored).not.toContain("private-cookie-first");
    expect(stored).not.toContain("private-cookie-rotated");
    expect((await local.runtime.execute(run.id)).status).toBe("succeeded");
    expect(seen.length).toBe(3);
  } finally {
    local.close();
  }
});

test("environment overrides are injected and redacted, and missing values fail before launch", async () => {
  const { home, cwd, registry, secrets, workflow } = setup();
  let calls = 0;
  const local = createLocalRuntime({
    home,
    executor: async (cmd) => {
      calls++;
      expect(cmd.env?.LOOPY_BOUND_COOKIE).toBe("explicit-cookie");
      return { stdout: cmd.env?.LOOPY_BOUND_COOKIE ?? "", stderr: "", exitCode: 0, durationMs: 0 };
    },
  });
  try {
    const saved = registry.get(workflow.slug);
    const options = { ...localRunOptions(cwd, "sandbox"), secretBindings: saved.secretBindings };
    process.env.LOOPY_BOUND_COOKIE = "explicit-cookie";
    const first = await local.runtime.createRun(saved.workflow, {}, options);
    expect((await local.runtime.execute(first.id)).status).toBe("succeeded");
    expect((await local.runtime.getAttempts(first.id))[0]?.output).toMatchObject({
      stdout: "[redacted]",
    });
    delete process.env.LOOPY_BOUND_COOKIE;
    secrets.remove("shared-cookie");
    const second = await local.runtime.createRun(saved.workflow, {}, options);
    expect((await local.runtime.execute(second.id)).status).toBe("failed");
    expect(calls).toBe(1);
    expect((await local.runtime.getAttempts(second.id))[0]?.status).toBe("failed");
  } finally {
    local.close();
  }
});

test("revocation and replacement prevent existing runs from using old grants", async () => {
  const { home, cwd, registry, workflow, directory } = setup();
  let calls = 0;
  const local = createLocalRuntime({
    home,
    executor: async () => {
      calls++;
      throw new Error("Should never launch");
    },
  });
  try {
    const saved = registry.get(workflow.slug);
    const options = { ...localRunOptions(cwd, "full"), secretBindings: saved.secretBindings };
    const revoked = await local.runtime.createRun(saved.workflow, {}, options);
    registry.unbindSecret(workflow.slug, "LOOPY_BOUND_COOKIE");
    expect((await local.runtime.execute(revoked.id)).status).toBe("failed");
    registry.bindSecret(workflow.slug, "LOOPY_BOUND_COOKIE", "shared-cookie");
    const replaced = await local.runtime.createRun(saved.workflow, {}, options);
    registry.save(workflow, join(directory, "other.ts"), { replace: true });
    registry.bindSecret(workflow.slug, "LOOPY_BOUND_COOKIE", "shared-cookie");
    expect((await local.runtime.execute(replaced.id)).status).toBe("failed");
    expect(calls).toBe(0);
  } finally {
    local.close();
  }
});

test("executor failures retain uncertainty while masking values and partial output", async () => {
  const { home, cwd, registry, workflow } = setup();
  const local = createLocalRuntime({
    home,
    executor: async (cmd) => {
      throw new CommandExecutionError(
        `Failed ${cmd.env?.LOOPY_BOUND_COOKIE}`,
        {
          stdout: "private-cookie-",
          stderr: cmd.env?.LOOPY_BOUND_COOKIE ?? "",
          exitCode: -1,
          durationMs: 0,
        },
        true,
      );
    },
  });
  try {
    const saved = registry.get(workflow.slug);
    const run = await local.runtime.createRun(
      saved.workflow,
      {},
      { ...localRunOptions(cwd, "full"), secretBindings: saved.secretBindings },
    );
    expect((await local.runtime.execute(run.id)).status).toBe("interrupted");
    const attempt = (await local.runtime.getAttempts(run.id))[0];
    expect(attempt?.status).toBe("uncertain");
    expect(attempt?.error).toBe("Failed [redacted]");
    expect(attempt?.output).toMatchObject({ stdout: "[redacted]", stderr: "[redacted]" });
  } finally {
    local.close();
  }
});

test("redaction handles overlapping values and regex punctuation", () => {
  expect(secretRedactor(["abc", "abcdef", "a.b?"])("abcdef abc a.b?")).toBe(
    "[redacted] [redacted] [redacted]",
  );
  expect(secretRedactor(["abcdef"])("prefix abc", true)).toBe("prefix [redacted]");
});

for (const mode of ["full", "sandbox"] as ExecutionMode[]) {
  test.skipIf(
    mode === "sandbox" &&
      process.platform !== "darwin" &&
      !(process.platform === "linux" && existsSync("/usr/bin/bwrap")),
  )(`real ${mode} process receives the secret and stdin without persisting it`, async () => {
    const { home, cwd, registry, workflow, source } = setup();
    const probe = trigger(workflow.slug)
      .config({ scope: "global" })
      .node("probe", {
        program: process.execPath,
        args: [
          "-e",
          "const crypto = require('node:crypto'); console.log(crypto.createHash('sha256').update(process.env.LOOPY_BOUND_COOKIE).digest('hex')); console.log(await Bun.stdin.text()); console.error(process.env.LOOPY_BOUND_COOKIE)",
        ],
        stdin: "ordinary input",
      })
      .build();
    registry.save(probe, source);
    const saved = registry.get(workflow.slug);
    const local = createLocalRuntime({ home });
    try {
      const run = await local.runtime.createRun(
        saved.workflow,
        {},
        { ...localRunOptions(cwd, mode), secretBindings: saved.secretBindings },
      );
      const finished = await local.runtime.execute(run.id);
      if (finished.status !== "succeeded")
        throw new Error(JSON.stringify(await local.runtime.getAttempts(run.id)));
      expect((await local.runtime.getAttempts(run.id))[0]?.output).toMatchObject({
        stdout: `${digest("private-cookie-first")}\nordinary input\n`,
        stderr: "[redacted]\n",
      });
    } finally {
      local.close();
    }
  });
}

test("CLI binding commands store references and run from a different directory", async () => {
  const { home, cwd, workflow, directory } = setup();
  const cli = [process.execPath, join(import.meta.dir, "../src/cli/index.ts")];
  async function invoke(args: string[]) {
    const child = Bun.spawn([...cli, ...args, "--home", home], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(stdout + stderr).not.toContain("private-cookie-first");
    expect(await child.exited).toBe(0);
    return JSON.parse(stdout);
  }
  await invoke(["secrets", "bind", workflow.slug, "LOOPY_BOUND_COOKIE", "shared-cookie"]);
  expect(await invoke(["secrets", "bindings", workflow.slug])).toEqual({
    slug: workflow.slug,
    bindings: { LOOPY_BOUND_COOKIE: "shared-cookie" },
  });
  const run = await invoke(["run", workflow.slug, "--full", "--cwd", cwd, "--input", "{}"]);
  expect(run.status).toBe("succeeded");
  await invoke(["inspect", run.id]);
  await invoke(["secrets", "unbind", workflow.slug, "LOOPY_BOUND_COOKIE"]);
  expect(await invoke(["secrets", "bindings", workflow.slug])).toEqual({
    slug: workflow.slug,
    bindings: {},
  });
  expect(readFileSync(join(home, "workflows", `${workflow.slug}.json`), "utf8")).not.toContain(
    "private-cookie-first",
  );
});

for (const key of ["toString", "constructor", "__proto__"]) {
  test(`inherited environment property ${key} does not override a stored secret`, async () => {
    const { home, cwd, registry, workflow } = setup();
    registry.unbindSecret(workflow.slug, "LOOPY_BOUND_COOKIE");
    registry.bindSecret(workflow.slug, key, "shared-cookie");
    let calls = 0;
    const local = createLocalRuntime({
      home,
      executor: async (cmd) => {
        calls++;
        expect(cmd.env?.[key]).toBe("private-cookie-first");
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
      },
    });
    try {
      const saved = registry.get(workflow.slug);
      const run = await local.runtime.createRun(
        saved.workflow,
        {},
        { ...localRunOptions(cwd, "full"), secretBindings: saved.secretBindings },
      );
      expect((await local.runtime.execute(run.id)).status).toBe("succeeded");
      expect(calls).toBe(1);
    } finally {
      local.close();
    }
  });
}

for (const [value, limit] of [
  ["abcédef", 4],
  ["\uFEFFabcdef", 5],
] as const) {
  test(`UTF-8 output limit ${limit} preserves secret prefixes for redaction`, async () => {
    const { home, cwd, registry, workflow, source, secrets } = setup();
    secrets.set("shared-cookie", value);
    const limited = trigger(workflow.slug)
      .config({ scope: "global" })
      .node("probe", {
        program: process.execPath,
        args: ["-e", "process.stdout.write(process.env.LOOPY_BOUND_COOKIE)"],
        maxOutputBytes: limit,
      })
      .build();
    registry.save(limited, source);
    const local = createLocalRuntime({ home });
    try {
      const saved = registry.get(workflow.slug);
      const run = await local.runtime.createRun(
        saved.workflow,
        {},
        { ...localRunOptions(cwd, "full"), secretBindings: saved.secretBindings },
      );
      expect((await local.runtime.execute(run.id)).status).toBe("interrupted");
      const attempt = (await local.runtime.getAttempts(run.id))[0];
      expect(attempt?.output).toMatchObject({ stdout: "[redacted]" });
      expect(JSON.stringify(attempt)).not.toContain(value);
    } finally {
      local.close();
    }
  });
}
