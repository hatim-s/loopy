import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRecord } from "../src/core/index.js";
import { openRunStore, startServer } from "../src/local/index.js";

const roots: string[] = [];

const servers: ReturnType<typeof startServer>[] = [];

const CLI = resolve(import.meta.dir, "../src/cli/index.ts");

const SDK = resolve(import.meta.dir, "../src/sdk/index.ts");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(name: string, definition: string) {
  const root = mkdtempSync(join(tmpdir(), "loopy-cli-sdk-"));
  roots.push(root);
  const home = join(root, "home");
  const file = join(root, `${name}.loopy.ts`);
  writeFileSync(
    file,
    `import { loopy, step, sleep, command } from ${JSON.stringify(SDK)};
export default loopy({ name: ${JSON.stringify(name)}, ${definition} });`,
  );

  return { cwd: root, home, file };
}

async function cli(f: ReturnType<typeof fixture>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, "--home", f.home, ...args], {
    cwd: f.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}

function object(text: string) {
  return requireRecord(JSON.parse(text), "CLI output");
}

async function save(f: ReturnType<typeof fixture>) {
  const result = await cli(f, "save", f.file);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);

  return object(result.stdout);
}

test("SDK CLI bundles, coerces named input, runs, inspects steps and prints logs", async () => {
  const f = fixture(
    "hello",
    `input: { name: "string", count: "number", "loud?": "boolean" },
    run: async ({ input, log }) => {
      const greeting = await step("greet", () => input);
      log.info("hello from sdk", greeting);
      return greeting;
    }`,
  );

  const saved = await save(f);
  expect(saved.input).toEqual({ name: "string", count: "number", "loud?": "boolean" });
  rmSync(f.file);

  const result = await cli(f, "run", "hello", "--name", "world", "--count", "2", "--loud", "false");

  expect(result.code).toBe(0);
  const run = object(result.stdout);
  expect(run.status).toBe("succeeded");
  expect(run.output).toEqual({ name: "world", count: 2, loud: false });
  const detail = object((await cli(f, "inspect", String(run.id))).stdout);
  expect(detail.steps).toMatchObject([
    { seq: 1, key: "greet", kind: "function", status: "succeeded", attempt: 1 },
  ]);
  expect((await cli(f, "logs", String(run.id))).stdout).toContain("hello from sdk");
  expect((await cli(f, "runs", "hello")).stdout).toContain(String(run.id));
  expect((await cli(f, "list")).stdout).toContain("hello");
});

test("Ctrl-C during sleep leaves the run suspended and resume completes it", async () => {
  const f = fixture(
    "nap",
    `mode: "full", run: async ({ log }) => {
    await step("before", () => 1);
    await sleep("1s");
    log.info("awake");
    return command("pwd", { program: "/bin/pwd", args: [] });
  }`,
  );

  await save(f);

  const child = Bun.spawn([process.execPath, CLI, "--home", f.home, "run", "nap"], {
    cwd: f.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new Response(child.stdout).text();
  const reader = child.stderr.getReader();
  const notice = await reader.read();
  expect(new TextDecoder().decode(notice.value)).toContain("wakes at");
  child.kill("SIGINT");
  expect(await child.exited).toBe(0);
  await reader.cancel();
  const run = object(await stdout);
  expect(run.status).toBe("suspended");
  const other = join(f.cwd, "other");
  mkdirSync(other);
  const resumed = await cli({ ...f, cwd: other }, "resume", String(run.id));
  expect(resumed.code).toBe(0);
  expect(object(resumed.stdout)).toMatchObject({
    status: "succeeded",
    workspace: realpathSync(f.cwd),
    output: { stdout: `${realpathSync(f.cwd)}\n` },
  });
  const detail = object((await cli(f, "inspect", String(run.id))).stdout);
  expect(detail.steps).toMatchObject([
    { key: "before", attempt: 1 },
    { kind: "sleep" },
    { key: "pwd", attempt: 1 },
  ]);
});

test("detach queues without loading secrets and a queued run can be cancelled", async () => {
  const f = fixture(
    "queued",
    `secrets: ["MISSING_TOKEN"], run: async () => step("answer", () => 42)`,
  );

  await save(f);
  const detached = await cli(f, "run", "queued", "--detach");
  expect(detached.code).toBe(0);
  const run = object(detached.stdout);
  expect(run.status).toBe("queued");
  expect((await cli(f, "inspect", String(run.id))).stdout).toContain('"steps": []');
  const cancelled = await cli(f, "cancel", String(run.id));
  expect(cancelled.code).toBe(0);
  expect(object(cancelled.stdout).status).toBe("cancelled");
});

test("JSON schema input is required, validated and accepted from JSON or a file", async () => {
  const f = fixture(
    "schema",
    `input: { "~standard": { version: 1, vendor: "test",
    validate(value: unknown) { return { value }; } } },
    run: async ({ input }) => step("echo", () => input)`,
  );

  expect((await save(f)).input).toBe("schema");
  const missing = await cli(f, "run", "schema");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("Supply --input-json");
  const json = await cli(f, "run", "schema", "--input-json", '{"nested":[1,true]}');
  expect(object(json.stdout).output).toEqual({ nested: [1, true] });
  writeFileSync(join(f.cwd, "input.json"), '{"from":"file"}');
  const file = await cli(f, "run", "schema", "--input-file", "input.json");
  expect(object(file.stdout).output).toEqual({ from: "file" });
});

test("record input errors do not create runs and failed workflows exit nonzero", async () => {
  const f = fixture(
    "failure",
    `input: { count: "number" }, run: async () => step("fail", () => { throw new Error("intentional failure"); }, { retry: { attempts: 1 } })`,
  );

  await save(f);
  const missing = await cli(f, "run", "failure");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("count: Expected number");
  const bad = await cli(f, "run", "failure", "--count", "wrong");
  expect(bad.stderr).toContain("must be a number");
  const unknown = await cli(f, "run", "failure", "--count", "1", "--extra", "x");
  expect(unknown.stderr).toContain("Unknown field");
  const failed = await cli(f, "run", "failure", "--count", "1");
  expect(failed.code).toBe(1);
  expect(object(failed.stdout).status).toBe("failed");
  expect(JSON.parse((await cli(f, "runs")).stdout)).toHaveLength(1);
});

test("schedule persists the next fire and off removes it", async () => {
  const f = fixture(
    "scheduled",
    `input: { count: "number" }, run: async ({ input }) => input.count`,
  );

  await save(f);

  const result = await cli(
    f,
    "schedule",
    "scheduled",
    "--cron",
    "*/5 * * * *",
    "--tz",
    "Asia/Kolkata",
    "--input-json",
    '{"count":2}',
  );

  expect(result.code).toBe(0);
  const schedule = object(result.stdout);
  expect(schedule.tz).toBe("Asia/Kolkata");
  expect(Date.parse(String(schedule.nextFireAt))).toBeGreaterThan(Date.now());
  const sub = join(f.cwd, "sub");
  mkdirSync(sub);
  const alias = join(f.cwd, "alias");
  symlinkSync(sub, alias);

  const repeated = await cli(
    { ...f, cwd: sub },
    "schedule",
    "scheduled",
    "--cron",
    "*/5 * * * *",
    "--input-json",
    '{"count":2}',
  );

  expect(repeated.code).toBe(0);
  expect(
    (
      await cli(
        f,
        "schedule",
        "scheduled",
        "--cwd",
        alias,
        "--cron",
        "*/5 * * * *",
        "--input-json",
        '{"count":2}',
      )
    ).code,
  ).toBe(0);
  const store = openRunStore(f.home);

  try {
    expect(await store.listSchedules()).toMatchObject([
      { workspace: realpathSync(f.cwd), slug: "scheduled" },
    ]);
    expect(await store.listSchedules()).toHaveLength(1);
    expect((await cli({ ...f, cwd: sub }, "schedule", "scheduled", "--off")).code).toBe(0);
    expect(await store.listSchedules()).toEqual([]);
  } finally {
    store.close();
  }
});

test("API returns run records, step traces and cursor logs", async () => {
  const f = fixture(
    "api",
    `run: async ({ log }) => { log.info("first"); await step("one", () => 1); log.info("second"); return 2; }`,
  );

  await save(f);
  const run = object((await cli(f, "run", "api")).stdout);
  const server = startServer({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const request = (path: string) => fetch(`${url.origin}/api${path}`, { headers });
  const detail = requireRecord(await (await request(`/runs/${run.id}`)).json(), "Run detail");
  expect(detail.steps).toMatchObject([{ key: "one", status: "succeeded" }]);
  expect(detail.logs).toMatchObject([{ message: "first" }, { message: "second" }]);
  expect(await (await request(`/runs/${run.id}/logs?after=1`)).json()).toMatchObject([
    { message: "second" },
  ]);
  expect((await request(`/runs/${run.id}/logs?after=-1`)).status).toBe(400);
  expect((await request("/runs/missing/logs")).status).toBe(404);
  expect(await (await request("/runs")).json()).toMatchObject([{ id: run.id }]);
});

test("cancel reports an active owner instead of stealing the run", async () => {
  const f = fixture("owned", "run: () => 42");
  await save(f);
  const run = object((await cli(f, "run", "owned", "--detach")).stdout);
  const id = String(run.id);
  const store = openRunStore(f.home);

  try {
    await store.claim(id, "test-owner");
    const cancelled = await cli(f, "cancel", id);
    expect(cancelled.code).toBe(1);
    expect(cancelled.stderr).toContain(`owned by PID ${process.pid}`);
    expect(await store.getRun(id)).toMatchObject({
      status: "running",
      owner: { token: "test-owner" },
    });
    await store.release(id, "test-owner");
  } finally {
    store.close();
  }
});

test("command-specific options preserve run input fields and reject invalid flags", async () => {
  const f = fixture(
    "flags",
    `input: { cron: "string", follow: "string" }, run: ({ input }) => input`,
  );

  await save(f);
  const result = await cli(f, "run", "flags", "--cron", "hello", "--follow", "yes");
  expect(result.code).toBe(0);
  expect(object(result.stdout).output).toEqual({ cron: "hello", follow: "yes" });
  const invalid = await cli(f, "logs", "x", "--detach");
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain("Unknown option '--detach' for loopy logs.");
});

test("missing secrets and incomplete input flags do not create queued runs", async () => {
  const f = fixture("secret", `secrets: ["MISSING_TOKEN"], run: () => 42`);
  await save(f);
  const missing = await cli(f, "run", "secret");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("MISSING_TOKEN");

  for (const flag of ["--full", "--retry-uncertain"]) {
    const invalid = await cli(f, "run", "secret", flag);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("requires a value");
  }

  expect(object((await cli(f, "run", "secret", "--detach")).stdout).status).toBe("queued");
  const store = openRunStore(f.home);

  try {
    expect(await store.listRuns()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("Ctrl-C interrupts a running command, releases ownership and retries on resume", async () => {
  const f = fixture(
    "interrupt",
    `mode: "full", run: () => command("wait", { program: "/bin/sleep", args: ["8"] })`,
  );

  await save(f);

  const child = Bun.spawn([process.execPath, CLI, "--home", f.home, "run", "interrupt"], {
    cwd: f.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  try {
    await Bun.sleep(1000);
    const at = performance.now();
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
    expect(performance.now() - at).toBeLessThan(2000);
    expect(await stderr).toBe("");
    const run = object(await stdout);
    expect(run.status).toBe("suspended");
    expect(run.owner).toBeUndefined();
    const store = openRunStore(f.home);

    try {
      expect(await store.getSteps(String(run.id))).toMatchObject([
        { status: "retrying", attempt: 1 },
      ]);
    } finally {
      store.close();
    }

    const resumed = await cli(f, "resume", String(run.id));
    expect(resumed.code).toBe(0);
    expect(object(resumed.stdout).status).toBe("succeeded");
    const detail = object((await cli(f, "inspect", String(run.id))).stdout);
    expect(detail.steps).toMatchObject([{ status: "succeeded", attempt: 2 }]);
  } finally {
    child.kill();
    await child.exited;
  }
}, 15_000);

test("schedule defaults come from the saved definition and logs follow emits NDJSON", async () => {
  const f = fixture(
    "defaults",
    `schedule: { cron: "*/5 * * * *", tz: "Asia/Kolkata" }, run: ({ log }) => { log.info("one"); log.info("two"); return 1; }`,
  );

  await save(f);
  const scheduled = await cli(f, "schedule", "defaults");
  expect(scheduled.code).toBe(0);
  expect(object(scheduled.stdout)).toMatchObject({ cron: "*/5 * * * *", tz: "Asia/Kolkata" });
  const run = object((await cli(f, "run", "defaults")).stdout);
  const logs = await cli(f, "logs", String(run.id), "--follow");
  expect(logs.code).toBe(0);
  expect(logs.stdout.trim().split("\n").map(object)).toMatchObject([
    { message: "one" },
    { message: "two" },
  ]);
});

test("inspect reports how to find a missing run", async () => {
  const f = fixture("missing", "run: () => 1");
  const result = await cli(f, "inspect", "nonexist");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("No run 'nonexist'. Use loopy runs to list run ids.");
});

test("Studio requires its token and origin, serves pinned assets and exposes read-only data", async () => {
  const f = fixture("studio", "run: () => 1");
  await save(f);
  const assets = join(f.cwd, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "original Studio");
  const server = startServer({ home: f.home, cwd: f.cwd, assets, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  expect((await fetch(`${url.origin}/api/runs`)).status).toBe(401);
  expect(
    (await fetch(`${url.origin}/api/runs`, { headers: { Authorization: "Bearer wrong" } })).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${url.origin}/api/runs`, {
        headers: { ...headers, Origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  expect(await (await fetch(`${url.origin}/api/loopies`, { headers })).json()).toMatchObject([
    { slug: "studio" },
  ]);
  expect((await fetch(`${url.origin}/api/runs`, { method: "POST", headers })).status).toBe(404);
  writeFileSync(join(assets, "index.html"), "changed Studio");
  const page = await fetch(url.origin);
  expect(await page.text()).toBe("original Studio");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("saved slugs require explicit replacement and project entries override global entries", async () => {
  const f = fixture("scoped", 'scope: "global", run: () => "global"');
  await save(f);
  const other = join(f.cwd, "other.loopy.ts");
  writeFileSync(
    other,
    `import { loopy } from ${JSON.stringify(SDK)}; export default loopy({ name: "scoped", scope: "global", run: () => "replacement" });`,
  );
  const conflict = await cli(f, "save", other);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain("belongs to another source");
  expect((await cli(f, "save", other, "--replace")).code).toBe(0);
  expect(object((await cli(f, "run", "scoped")).stdout).output).toBe("replacement");
  writeFileSync(
    f.file,
    `import { loopy } from ${JSON.stringify(SDK)}; export default loopy({ name: "scoped", run: () => "project" });`,
  );
  await save(f);
  const child = join(f.cwd, "nested");
  mkdirSync(child);
  const local = await cli({ ...f, cwd: child }, "run", "scoped");
  expect(local.code).toBe(0);
  expect(object(local.stdout).output).toBe("project");
  expect(JSON.parse((await cli(f, "list")).stdout)).toHaveLength(1);
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`${signal} recovery retries a long step with the next attempt`, async () => {
    const f = fixture(
      "crash",
      `mode: "full", run: () => step("long", async ({ attempt }) => {
      if (attempt === 1) { await new Promise((resolve) => { setTimeout(resolve, 30_000).unref(); }); }
      return attempt;
    })`,
    );

    await save(f);

    const child = Bun.spawn([process.execPath, CLI, "--home", f.home, "run", "crash"], {
      cwd: f.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const store = openRunStore(f.home);

    try {
      let id: string | undefined;

      for (let tries = 0; tries < 100; tries++) {
        const [run] = await store.listRuns();

        if (run && (await store.getSteps(run.id))[0]?.status === "running") {
          id = run.id;
          break;
        }

        await Bun.sleep(20);
      }

      if (!id) {
        throw new Error("CLI never started the long step.");
      }

      child.kill(signal);
      await child.exited;
      await stdout;
      expect(await stderr).toBe("");

      if (signal === "SIGKILL") {
        const db = new Database(join(f.home, "runs.sqlite"));

        try {
          db.query("UPDATE runs SET owner_host=?,heartbeat_at=? WHERE id=?").run(
            "other-host",
            new Date().toISOString(),
            id,
          );
        } finally {
          db.close();
        }

        expect((await cli(f, "resume", id, "--lease-ms", "1000")).code).toBe(1);
        await Bun.sleep(1010);
      }

      const resumed = await cli(f, "resume", id, "--lease-ms", "1000");
      expect(resumed.stderr).toBe("");
      expect(resumed.code).toBe(0);
      expect(object(resumed.stdout)).toMatchObject({ status: "succeeded", output: 2 });
      expect(await store.getSteps(id)).toMatchObject([{ attempt: 2, status: "succeeded" }]);
    } finally {
      child.kill();
      await child.exited;
      store.close();
    }
  });
}

test("loopy types generates a git wrapper that can execute --version", async () => {
  const f = fixture("generated-git", "run: () => 1");
  const generated = join(f.cwd, "git.ts");
  const result = await cli(f, "types", "git", "--out", generated, "--name", "generatedGit");
  expect(result.code).toBe(0);
  writeFileSync(
    generated,
    (await Bun.file(generated).text()).replace('from "loopy"', `from ${JSON.stringify(SDK)}`),
  );
  writeFileSync(
    f.file,
    `import { loopy } from ${JSON.stringify(SDK)};
    import { generatedGit } from "./git.ts";
    export default loopy({ name: "generated-git", mode: "full", run: () => generatedGit({ args: ["--version"] }) });`,
  );
  await save(f);
  const run = await cli(f, "run", "generated-git");
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  expect(object(run.stdout).output).toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("git version"),
  });
});

test("API distinguishes invalid cursors from registry failures", async () => {
  const f = fixture("server-errors", "run: () => 1");
  await save(f);
  const run = object((await cli(f, "run", "server-errors")).stdout);
  const server = startServer({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  expect((await fetch(`${url.origin}/api/runs/${run.id}/logs?after=bad`, { headers })).status).toBe(
    400,
  );
  writeFileSync(join(f.cwd, ".loopy", "loopies", "server-errors.json"), "invalid JSON");
  expect((await fetch(`${url.origin}/api/loopies`, { headers })).status).toBe(500);
  expect((await fetch(`${url.origin}/api/config`, { headers })).status).toBe(404);
});

test("CLI rejects leases shorter than one second", async () => {
  const f = fixture("short-lease", "run: () => 1");
  const result = await cli(f, "runs", "--lease-ms", "999");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "--lease-ms must be an integer of at least 1000. Use 1000 or more.",
  );
});

test("a short lease cannot steal a live inline run but recovers its dead PID", async () => {
  const f = fixture(
    "live-lease",
    `run: () => step("long", async ({ attempt }) => {
    if (attempt === 1) { await new Promise((resolve) => setTimeout(resolve, 30_000)); }
    return attempt;
  })`,
  );

  await save(f);

  const child = Bun.spawn([process.execPath, CLI, "--home", f.home, "run", "live-lease"], {
    cwd: f.cwd,
    stdout: "ignore",
    stderr: "pipe",
  });

  const store = openRunStore(f.home);

  try {
    const run = await waitForRunningStep(store);
    await Bun.sleep(2100);
    const blocked = await cli(f, "resume", run.id, "--lease-ms", "2000");
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("not owned by this token");
    expect((await store.getRun(run.id))?.owner?.pid).toBe(child.pid);
    child.kill("SIGKILL");
    await child.exited;
    const resumed = await cli(f, "resume", run.id, "--lease-ms", "2000");
    expect(resumed.stderr).toBe("");
    expect(resumed.code).toBe(0);
    expect(object(resumed.stdout)).toMatchObject({ status: "succeeded", output: 2 });
  } finally {
    child.kill();
    await child.exited;
    store.close();
  }
}, 10_000);

async function waitForRunningStep(store: ReturnType<typeof openRunStore>) {
  for (let tries = 0; tries < 100; tries++) {
    const [run] = await store.listRuns();

    if (run && (await store.getSteps(run.id))[0]?.status === "running") {
      return run;
    }

    await Bun.sleep(20);
  }

  throw new Error("CLI never started the long step. Check its stderr.");
}

test("API can omit log history while preserving steps and cursor reads", async () => {
  const f = fixture(
    "summary",
    'run: ({ log }) => step("work", () => { log.info("hello"); return 1; })',
  );

  await save(f);
  const run = object((await cli(f, "run", "summary")).stdout);
  const server = startServer({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const path = `${url.origin}/api/runs/${run.id}`;
  const full = object(await (await fetch(path, { headers })).text());
  const summary = object(await (await fetch(`${path}?logs=false`, { headers })).text());
  expect(full.steps).toHaveLength(1);
  expect(full.logs).toHaveLength(1);
  expect(summary).toEqual({ run: full.run, steps: full.steps });
  expect(await (await fetch(`${path}/logs?after=0`, { headers })).json()).toEqual(full.logs);
  expect(await (await fetch(`${path}/logs?after=1`, { headers })).json()).toEqual([]);
  expect((await fetch(`${url.origin}/api/runs/missing?logs=false`, { headers })).status).toBe(404);
});

test("CLI reads rate limit config at startup and rejects malformed limits", async () => {
  const f = fixture(
    "limited",
    `run: async () => step("limited", () => 42, { rateLimit: "codex" })`,
  );

  await save(f);
  writeFileSync(join(f.home, "config.json"), JSON.stringify({ rateLimits: { codex: "2/1m" } }));
  expect(object((await cli(f, "run", "limited")).stdout)).toMatchObject({
    status: "succeeded",
    output: 42,
  });
  writeFileSync(join(f.home, "config.json"), JSON.stringify({ rateLimits: { codex: "0/1m" } }));
  const invalid = await cli(f, "run", "limited");
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain(
    "Rate limit 'codex' is invalid. Use a positive count and duration such as '10/1h' in config.json.",
  );
  writeFileSync(join(f.home, "config.json"), "{");
  const malformed = await cli(f, "run", "limited");
  expect(malformed.code).toBe(1);
  expect(malformed.stderr).toContain(
    `Invalid config file '${join(f.home, "config.json")}'. Fix or delete it.`,
  );
});
