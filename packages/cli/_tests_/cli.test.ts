import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBoundary, nodeIdSchema } from "@loopy/contract";
import { localDaemon, Registry, readDaemonFile } from "@loopy/runtime/local";
import { openRunStore } from "@loopy/runtime/store";
import { Effect } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { fixture, object } from "../../runtime/_tests_/fixtures/project";
import { onCleanup, runScoped } from "../../runtime/_tests_/fixtures/test-scope";
import { waitForExit } from "../../runtime/_tests_/fixtures/wait";
import { cli } from "./fixtures/cli";

async function graphFixture(name = "compiled") {
  const f = fixture(name, "run: () => null");
  writeFileSync(
    f.file,
    `import { loopy, log } from "loopy"; export default loopy(${JSON.stringify(name)}, { input: {count: "number"}, run: ({input}) => {log("ready"); return input.get("count");}});`,
  );
  const store = await runScoped(openRunStore(f.home));

  const daemon = await runScoped(
    localDaemon({ ...f, store, concurrency: 4, port: 0, assets: join(f.cwd, "assets") }),
  );

  await runScoped(daemon.start);

  return { ...f, store };
}

test("save posts a compiled graph and graph prints the same redacted view by file and name", async () => {
  const f = await graphFixture();
  const saved = await cli(f, "save", f.file);
  expect(saved).toMatchObject({ code: 0, stderr: "" });
  const view = object(saved.stdout);
  expect(view.name).toBe("compiled");
  expect(object((await cli(f, "graph", "compiled")).stdout)).toEqual(view);
  expect(object((await cli(f, "graph", f.file)).stdout)).toEqual(view);
  const text = await cli(f, "graph", "compiled", "--format", "text");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("0:log log [next -> 1:join]");
});

test("HTTP commands queue schema-validated graph runs and pin the saved revision", async () => {
  const f = await graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  expect((await cli(f, "run", "compiled", "--count", "bad")).code).toBe(1);
  expect(JSON.parse((await cli(f, "runs")).stdout)).toEqual([]);
  const queued = await cli(f, "run", "compiled", "--count", "2");
  expect(queued).toMatchObject({ code: 0, stderr: "" });
  const run = object(queued.stdout);
  expect(run).toMatchObject({ status: "queued", input: { count: 2 } });
  expect(await runGraph(f.home, String(run.id))).toMatchObject({
    revision: (await registryEntry(f.home, f.cwd, "compiled")).revision,
  });
  expect(object((await cli(f, "inspect", String(run.id))).stdout).run).toMatchObject({
    id: run.id,
  });
  expect(object((await cli(f, "cancel", String(run.id))).stdout)).toMatchObject({
    status: "cancelled",
  });
});

test("save forwards --replace and registers outside files beside their source unless --cwd is explicit", async () => {
  const f = await graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  const other = join(f.cwd, "other.ts");
  writeFileSync(other, await Bun.file(f.file).text());
  expect((await cli(f, "save", other, "--replace")).code).toBe(0);
  expect((await registryEntry(f.home, f.cwd, "compiled")).source).toBe(other);
  const caller = join(f.cwd, "caller");
  mkdirSync(caller, { recursive: true });
  mkdirSync(join(caller, ".loopy", "loopies"), { recursive: true });
  expect((await cli({ ...f, cwd: caller }, "save", other)).code).toBe(0);
  expect((await registryEntry(f.home, f.cwd, "compiled")).source).toBe(other);
  expect((await cli({ ...f, cwd: caller }, "save", other, "--cwd", caller)).code).toBe(0);
  expect((await registryEntry(f.home, caller, "compiled")).source).toBe(other);
});

test("compiler diagnostics include locations and do not create registry entries", async () => {
  const f = await graphFixture();
  writeFileSync(
    f.file,
    `import {loopy} from "loopy"; export default loopy("bad", {input:{},run:async()=>1});`,
  );
  const result = await cli(f, "save", f.file);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("[synchronous_run]");
  expect(
    await Effect.runPromise(Effect.flatMap(Registry.make(f.home, f.cwd), (r) => r.list())),
  ).toEqual([]);
});

test("CLI rejects invalid graph formats, short daemon leases and leases on data commands", async () => {
  const f = await graphFixture();
  expect((await cli(f, "graph", f.file, "--format", "svg")).stderr).toContain(
    "--format json or --format text",
  );
  expect((await cli(f, "daemon", "run", "--lease-ms", "999")).stderr).toContain("at least 1000");
  expect((await cli(f, "runs", "--lease-ms", "2000")).stderr).toContain(
    "Unknown option '--lease-ms' for loopy runs.",
  );
});

test("save starts the daemon on demand and leaves artifact writes to the service", async () => {
  const f = fixture("on-demand", "run: () => null");
  writeFileSync(
    f.file,
    `import {loopy} from "loopy"; export default loopy("on-demand", {input:{},run:()=>null});`,
  );
  // List takes no save lock, so both startup contenders must succeed.
  const [result, concurrent] = await Promise.all([cli(f, "save", f.file), cli(f, "list")]);
  const record = readDaemonFile(f.home);

  if (record) {
    onCleanup(async () => {
      process.kill(record.pid, "SIGTERM");
      await waitForExit(record.pid);
    });
  }

  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(concurrent).toMatchObject({ code: 0, stderr: "" });
  expect(record?.pid).not.toBe(process.pid);
  expect((await registryEntry(f.home, f.cwd, "on-demand")).graph.name).toBe("on-demand");
});

test("list and schedules use the caller workspace when the daemon started elsewhere", async () => {
  const f = await graphFixture();
  const other = join(f.cwd, "other");
  mkdirSync(other);
  const file = join(other, "other.ts");
  writeFileSync(
    file,
    `import {loopy} from "loopy"; export default loopy("other", {input:{},run:()=>null});`,
  );
  const caller = { ...f, cwd: other };
  expect((await cli(caller, "save", file, "--cwd", other)).code).toBe(0);
  expect(JSON.parse((await cli(caller, "list")).stdout)).toMatchObject([{ slug: "other" }]);
  expect((await cli(caller, "schedule", "other", "--cron", "* * * * *")).code).toBe(0);
});

test("types uses the daemon's command-help endpoint and writes the returned source", async () => {
  const f = await graphFixture();
  const result = await cli(f, "types", "git", "--out", "git.ts");
  expect(result.code).toBe(0);
  expect(await Bun.file(join(f.cwd, "git.ts")).text()).toContain("defineCommand");
});

test("an absolute source in another project is registered beside that source", async () => {
  const source = await graphFixture("external-source");
  const caller = fixture("unrelated-caller", "run: () => null");
  const saved = await cli({ ...caller, home: source.home }, "save", source.file);
  expect(saved).toMatchObject({ code: 0, stderr: "" });
  expect((await registryEntry(source.home, source.cwd, "external-source")).source).toBe(
    source.file,
  );
  expect(
    await Effect.runPromise(
      Effect.flatMap(Registry.make(source.home, caller.cwd), (r) => r.list()),
    ),
  ).toEqual([]);
});

test("HTTP schedule enable, disable and off persist their state", async () => {
  const f = await graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  expect(
    await cli(f, "schedule", "compiled", "--cron", "0 * * * *", "--input-json", '{"count":2}'),
  ).toMatchObject({ code: 0, stderr: "" });

  for (const [action, enabled] of [
    ["--disable", false],
    ["--enable", true],
  ] as const) {
    expect(object((await cli(f, "schedule", "compiled", action)).stdout)).toMatchObject({
      enabled,
      input: { count: 2 },
      cron: "0 * * * *",
    });
    expect(JSON.parse((await cli(f, "list")).stdout)).toMatchObject([{ schedule: { enabled } }]);
  }

  expect((await cli(f, "schedule", "compiled", "--off")).code).toBe(0);
  expect(JSON.parse((await cli(f, "list")).stdout)).toMatchObject([{ schedule: null }]);
});

test("HTTP cancel refuses an active owner and inspect diagnoses a missing run", async () => {
  const f = await graphFixture();
  await Effect.runPromise(
    f.store.createRun({ ...newRun(), id: "owned", slug: "compiled", workspace: f.cwd }),
  );
  await Effect.runPromise(f.store.claim("owned", "active-owner"));
  const cancelled = await cli(f, "cancel", "owned");
  expect(cancelled.code).toBe(1);
  expect(cancelled.stderr).toContain("owned");
  expect(object((await cli(f, "inspect", "owned")).stdout).run).toMatchObject({
    status: "running",
    owner: { host: expect.any(String) },
  });
  const missing = await cli(f, "inspect", "missing-run");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("No run 'missing-run'");
});

test("HTTP logs drains every page for normal output and terminal follow", async () => {
  const f = await graphFixture();
  await Effect.runPromise(
    f.store.createRun({ ...newRun(), id: "logged", slug: "compiled", workspace: f.cwd }),
  );
  await Effect.runPromise(f.store.claim("logged", "log-owner"));

  for (const index of [...Array(250).keys()]) {
    await Effect.runPromise(
      f.store.apply({
        runId: "logged",
        token: "log-owner",
        effects: [
          {
            kind: "write_log",
            executionKey: {
              runId: "logged",
              nodeId: decodeBoundary(nodeIdSchema)("0:log"),
              scope: [],
            },
            attempt: 1,
            log: { message: `line ${index}`, data: null },
            at: new Date().toISOString(),
          },
        ],
      }),
    );
  }

  await Effect.runPromise(
    f.store.apply({
      runId: "logged",
      token: "log-owner",
      effects: [
        {
          kind: "finish_run",
          outcome: { status: "succeeded", output: null },
          at: new Date().toISOString(),
        },
      ],
    }),
  );
  await Effect.runPromise(f.store.release("logged", "log-owner"));
  const result = await cli(f, "logs", "logged", "--follow");
  expect(result).toMatchObject({ code: 0, stderr: "" });

  const followed = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(followed[0]).toMatchObject({ message: "line 0" });
  expect(followed.at(-1)).toMatchObject({ message: "line 249" });
  expect(followed.map((line) => line.seq)).toEqual(
    [...Array(250).keys()].map((index) => index + 1),
  );
  const normal = await cli(f, "logs", "logged");
  expect(normal).toMatchObject({ code: 0, stderr: "" });
  expect([...normal.stdout.matchAll(/"seq":\s*(\d+)/g)].map((match) => Number(match[1]))).toEqual(
    followed.map((line) => line.seq),
  );
});

test("HTTP run reports named JSON input errors before creating a run", async () => {
  const f = await graphFixture();
  writeFileSync(
    f.file,
    'import {loopy} from "loopy"; export default loopy("compiled",{input:{payload:"json",values:"number[]"},run:()=>null});',
  );
  expect((await cli(f, "save", f.file)).code).toBe(0);

  for (const [field, value, message] of [
    ["payload", "{", "Input --payload must be valid JSON."],
    ["values", '[1,"two"]', "Input --values must be a number[]."],
  ]) {
    const result = await cli(f, "run", "compiled", `--${field}`, value ?? "");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message ?? "");
  }

  expect(JSON.parse((await cli(f, "runs")).stdout)).toEqual([]);
});

/** The revision a run pinned, read from the daemon's HTTP API as the dashboard reads it. */
async function runGraph(home: string, id: string) {
  const daemon = readDaemonFile(home);

  const response = await fetch(`http://127.0.0.1:${daemon?.port}/api/runs/${id}/graph`, {
    headers: { Authorization: `Bearer ${daemon?.token}` },
  });

  return object(await response.text());
}

async function registryEntry(home: string, cwd: string, slug: string) {
  const entry = await Effect.runPromise(
    Effect.flatMap(Registry.make(home, cwd), (r) => r.get(slug)),
  );

  if (entry === null) {
    throw new Error(`Expected saved loopy '${slug}'.`);
  }

  return entry;
}
