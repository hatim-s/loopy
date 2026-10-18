import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nodeIdSchema } from "../src/contract/index.js";
import { processAlive } from "../src/executor/index.js";
import { localDaemon, Registry, readDaemonFile } from "../src/local/index.js";
import { openRunStore } from "../src/store/index.js";
import { cli, fixture, object, roots } from "./cli-fixture.js";
import { newRun, present } from "./fixture.js";

const daemons: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function stopProcess(pid: number) {
  process.kill(pid, "SIGTERM");

  for (let attempt = 0; attempt < 250 && processAlive(pid); attempt++) {
    await Bun.sleep(20);
  }
}

// A daemon started on demand is a detached process, so the test stops it by its discovery record.
async function stopDiscoveredDaemons(home: string) {
  const first = readDaemonFile(home);

  if (first) {
    await stopProcess(first.pid);
  }

  const second = readDaemonFile(home);

  if (second) {
    await stopProcess(second.pid);
  }
}

async function graphFixture(name = "compiled") {
  const f = fixture(name, "run: () => null");
  writeFileSync(
    f.file,
    `import { loopy, log } from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/index.ts"))}; export default loopy(${JSON.stringify(name)}, { input: {count: "number"}, run: ({input}) => {log("ready"); return input.get("count");}});`,
  );
  const store = openRunStore(f.home);
  const daemon = localDaemon({ ...f, store, concurrency: 4, port: 0 });
  await daemon.start();
  daemons.push({
    async stop() {
      await daemon.stop();
      store.close();
    },
  });

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
  const entry = present(new Registry(f.home, f.cwd).get("compiled"));
  expect(entry).toMatchObject({
    version: 2,
    graph: { name: "compiled" },
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});

test("HTTP commands queue schema-validated graph runs and pin the saved revision", async () => {
  const f = await graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  expect((await cli(f, "run", "compiled", "--count", "bad")).code).toBe(1);
  expect(await f.store.listRuns()).toEqual([]);
  const queued = await cli(f, "run", "compiled", "--count", "2");
  expect(queued).toMatchObject({ code: 0, stderr: "" });
  const run = object(queued.stdout);
  expect(run).toMatchObject({ status: "queued", input: { count: 2 } });
  expect(await f.store.getRun(String(run.id))).toMatchObject({
    revision: present(new Registry(f.home, f.cwd).get("compiled")).revision,
  });
  expect(object((await cli(f, "inspect", String(run.id))).stdout).run).toMatchObject({
    id: run.id,
  });
  expect(object((await cli(f, "cancel", String(run.id))).stdout)).toMatchObject({
    status: "cancelled",
  });
});

test("save rejects another source until --replace and locates absolute files beside their source", async () => {
  const f = await graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  const other = join(f.cwd, "other.ts");
  writeFileSync(other, await Bun.file(f.file).text());
  const rejected = await cli(f, "save", other);
  expect(rejected.stderr).toContain("[source_conflict]");
  expect((await cli(f, "save", other, "--replace")).code).toBe(0);
  const caller = join(f.cwd, "caller");
  mkdirSync(caller);
  expect((await cli({ ...f, cwd: caller }, "save", other)).code).toBe(0);
  expect(present(new Registry(f.home, f.cwd).get("compiled")).source).toBe(other);
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
  expect(new Registry(f.home, f.cwd).list()).toEqual([]);
});

test("save starts the daemon on demand and leaves artifact writes to the service", async () => {
  const f = fixture("on-demand", "run: () => null");
  writeFileSync(
    f.file,
    `import {loopy} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/index.ts"))}; export default loopy("on-demand", {input:{},run:()=>null});`,
  );
  daemons.push({ stop: () => stopDiscoveredDaemons(f.home) });
  // Two commands race to start the daemon; list takes no save lock, so both must succeed.
  const [result, concurrent] = await Promise.all([cli(f, "save", f.file), cli(f, "list")]);
  const record = readDaemonFile(f.home);

  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(concurrent).toMatchObject({ code: 0, stderr: "" });
  expect(object(result.stdout)).toMatchObject({ name: "on-demand" });
  expect(record?.pid).not.toBe(process.pid);
  expect(present(new Registry(f.home, f.cwd).get("on-demand")).graph.name).toBe("on-demand");
});

test("list and schedules use the caller workspace when the daemon started elsewhere", async () => {
  const f = await graphFixture();
  const other = join(f.cwd, "other");
  mkdirSync(other);
  const file = join(other, "other.ts");
  writeFileSync(
    file,
    `import {loopy} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/index.ts"))}; export default loopy("other", {input:{},run:()=>null});`,
  );
  const caller = { ...f, cwd: other };
  expect((await cli(caller, "save", file, "--cwd", other)).code).toBe(0);
  expect(JSON.parse((await cli(caller, "list")).stdout)).toMatchObject([{ slug: "other" }]);
  expect((await cli(caller, "schedule", "other", "--cron", "* * * * *")).code).toBe(0);
});

test("an absolute source in another project is registered beside that source", async () => {
  const source = await graphFixture("external-source");
  const caller = fixture("unrelated-caller", "run: () => null");
  const saved = await cli({ ...caller, home: source.home }, "save", source.file);
  expect(saved).toMatchObject({ code: 0, stderr: "" });
  expect(present(new Registry(source.home, source.cwd).get("external-source")).source).toBe(
    source.file,
  );
  expect(new Registry(source.home, caller.cwd).list()).toEqual([]);
});

test("save preserves every author option from graph meta", async () => {
  const f = await graphFixture("metadata");

  const meta = {
    description: "Author metadata",
    schedule: { cron: "0 9 * * *", tz: "Asia/Kolkata" },
    secrets: ["TOKEN"],
    mode: "full",
    scope: "global",
  };

  writeFileSync(
    f.file,
    `import {loopy} from "loopy"; export default loopy("metadata", {${JSON.stringify(meta).slice(1, -1)},input:{count:"number"},run:({input})=>input.get("count")});`,
  );
  expect(await cli(f, "save", f.file)).toMatchObject({ code: 0, stderr: "" });
  const saved = present(new Registry(f.home, f.cwd).get("metadata"));
  expect(saved.graph).toMatchObject({ meta, input: { count: "number" } });
});

test("HTTP logs follow prints each log as a separate JSON line", async () => {
  const f = await graphFixture();
  await f.store.createRun({
    ...newRun(),
    id: "logged",
    slug: "compiled",
    projectRoot: f.cwd,
    runDirectory: f.cwd,
  });
  await f.store.claim("logged", "log-owner");

  for (const index of [0, 1]) {
    await f.store.apply({
      runId: "logged",
      token: "log-owner",
      effects: [
        {
          kind: "write_log",
          executionKey: { runId: "logged", nodeId: nodeIdSchema.parse("0:log"), scope: [] },
          attempt: 1,
          log: { message: `line ${index}`, data: null },
          at: new Date().toISOString(),
        },
      ],
    });
  }

  await f.store.apply({
    runId: "logged",
    token: "log-owner",
    effects: [
      {
        kind: "finish_run",
        outcome: { status: "succeeded", output: null },
        at: newRun().createdAt,
      },
    ],
  });
  await f.store.release("logged", "log-owner");
  const result = await cli(f, "logs", "logged", "--follow");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toMatchObject([{ message: "line 0" }, { message: "line 1" }]);
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

  expect(await f.store.listRuns()).toEqual([]);
});
