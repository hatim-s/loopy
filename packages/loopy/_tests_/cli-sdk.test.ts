import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRecord } from "../src/core/index.js";
import { openEngineStore, startServer } from "../src/local/index.js";

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
  expect(existsSync(join(f.home, "runs.sqlite"))).toBe(false);
  rmSync(f.file);

  const result = await cli(
    f,
    "run",
    "hello",
    "--",
    "--name",
    "Hatim",
    "--count",
    "2",
    "--loud",
    "false",
  );

  expect(result.code).toBe(0);
  const run = object(result.stdout);
  expect(run.status).toBe("succeeded");
  expect(run.output).toEqual({ name: "Hatim", count: 2, loud: false });
  const detail = object((await cli(f, "inspect", String(run.id))).stdout);
  expect(detail.steps).toMatchObject([
    { seq: 1, key: "greet", kind: "function", status: "succeeded", attempt: 1 },
  ]);
  expect((await cli(f, "logs", String(run.id))).stdout).toContain("hello from sdk");
  expect((await cli(f, "runs", "hello")).stdout).toContain(String(run.id));
  expect((await cli(f, "list")).stdout).toContain("hello");
  expect(existsSync(join(f.home, "runs.sqlite"))).toBe(false);
});

test("Ctrl-C during sleep leaves the run suspended and resume completes it", async () => {
  const f = fixture(
    "nap",
    `run: async ({ log }) => {
    await step("before", () => 1);
    await sleep("1s");
    log.info("awake");
    return step("after", () => 2);
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
  const resumed = await cli(f, "resume", String(run.id));
  expect(resumed.code).toBe(0);
  expect(object(resumed.stdout).status).toBe("succeeded");
  const detail = object((await cli(f, "inspect", String(run.id))).stdout);
  expect(detail.steps).toMatchObject([
    { key: "before", attempt: 1 },
    { kind: "sleep" },
    { key: "after", attempt: 1 },
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
  expect((await cli(f, "schedule", "scheduled", "--off")).code).toBe(0);
  const store = openEngineStore(f.home);

  try {
    expect(await store.listSchedules()).toEqual([]);
  } finally {
    store.close();
  }
});

test("engine API returns run trace and cursor logs while leaving the legacy store unopened", async () => {
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
  expect(existsSync(join(f.home, "runs.sqlite"))).toBe(false);
});

test("cancel reports an active owner instead of stealing the run", async () => {
  const f = fixture("owned", "run: () => 42");
  await save(f);
  const run = object((await cli(f, "run", "owned", "--detach")).stdout);
  const id = String(run.id);
  const store = openEngineStore(f.home);

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
