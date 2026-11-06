import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { decodeBoundary, nodeIdSchema } from "../src/contract";
import { localDaemon, openRunStore, Registry, readDaemonFile } from "../src/local";
import { cli, fixture, object, roots } from "./cli-fixture";
import { newRun } from "./fixture";

const daemons: {
  stop(): Promise<void>;
}[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function graphFixture(name = "compiled") {
  const f = fixture(name, "run: () => null");
  writeFileSync(
    f.file,
    `import { loopy, log } from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))}; export default loopy(${JSON.stringify(name)}, { input: {count: "number"}, run: ({input}) => {log("ready"); return input.get("count");}});`,
  );
  const scope = Effect.runSync(Scope.make());
  daemons.push({ stop: () => Effect.runPromise(Scope.close(scope, Exit.void)) });

  const { store } = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* openRunStore(f.home);
      const daemon = yield* localDaemon({ ...f, store, concurrency: 4, port: 0 });
      yield* daemon.start;

      return { store };
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );

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
  const entry = await registryEntry(f.home, f.cwd, "compiled");
  expect(entry).toMatchObject({
    version: 2,
    graph: { name: "compiled" },
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    bundles: [],
  });
  expect(entry).not.toHaveProperty("bundleHash");
});

test("HTTP commands queue schema-validated graph runs and pin the saved revision", async () => {
  const f = await graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  expect((await cli(f, "run", "compiled", "--count", "bad")).code).toBe(1);
  expect(await Effect.runPromise(f.store.listRuns())).toEqual([]);
  const queued = await cli(f, "run", "compiled", "--count", "2");
  expect(queued).toMatchObject({ code: 0, stderr: "" });
  const run = object(queued.stdout);
  expect(run).toMatchObject({ status: "queued", input: { count: 2 } });
  expect(await Effect.runPromise(f.store.getRun(String(run.id)))).toMatchObject({
    revision: (await registryEntry(f.home, f.cwd, "compiled")).revision,
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
  expect(rejected.stderr).toContain("belongs to another source");
  expect((await cli(f, "save", other, "--replace")).code).toBe(0);
  const caller = join(f.cwd, "caller");
  mkdirSync(caller);
  expect((await cli({ ...f, cwd: caller }, "save", other)).code).toBe(0);
  expect((await registryEntry(f.home, f.cwd, "compiled")).source).toBe(other);
});

test("compiler diagnostics include locations and do not create registry entries", async () => {
  const f = await graphFixture();
  writeFileSync(
    f.file,
    `import {loopy} from "loopy/graph"; export default loopy("bad", {input:{},run:async()=>1});`,
  );
  const result = await cli(f, "save", f.file);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("[synchronous_run]");
  expect(
    await Effect.runPromise(Effect.flatMap(Registry.make(f.home, f.cwd), (r) => r.list())),
  ).toEqual([]);
});

test("CLI rejects invalid graph formats and short leases", async () => {
  const f = await graphFixture();
  expect((await cli(f, "graph", f.file, "--format", "svg")).stderr).toContain(
    "--format json or --format text",
  );
  expect((await cli(f, "runs", "--lease-ms", "999")).stderr).toContain("at least 1000");
});

test("save starts the daemon on demand and leaves artifact writes to the service", async () => {
  const f = fixture("on-demand", "run: () => null");
  writeFileSync(
    f.file,
    `import {loopy} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))}; export default loopy("on-demand", {input:{},run:()=>null});`,
  );
  // List takes no save lock, so both startup contenders must succeed.
  const [result, concurrent] = await Promise.all([cli(f, "save", f.file), cli(f, "list")]);
  const record = readDaemonFile(f.home);

  if (record) {
    daemons.push({
      async stop() {
        process.kill(record.pid, "SIGTERM");

        for (let attempt = 0; attempt < 100 && readDaemonFile(f.home); attempt++) {
          await Bun.sleep(20);
        }
      },
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
    `import {loopy} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))}; export default loopy("other", {input:{},run:()=>null});`,
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
    `import {loopy} from "loopy/graph"; export default loopy("metadata", {${JSON.stringify(meta).slice(1, -1)},input:{count:"number"},run:({input})=>input.get("count")});`,
  );
  expect(await cli(f, "save", f.file)).toMatchObject({ code: 0, stderr: "" });
  const saved = await registryEntry(f.home, f.cwd, "metadata");
  expect(saved).toMatchObject({ ...meta, input: { count: "number" }, graph: { meta } });
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
    });
    expect(await Effect.runPromise(f.store.listSchedules())).toMatchObject([
      { enabled, input: { count: 2 }, cron: "0 * * * *" },
    ]);
    expect(JSON.parse((await cli(f, "list")).stdout)).toMatchObject([{ schedule: { enabled } }]);
  }

  expect((await cli(f, "schedule", "compiled", "--off")).code).toBe(0);
  expect(await Effect.runPromise(f.store.listSchedules())).toEqual([]);
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
  expect(await Effect.runPromise(f.store.getRun("owned"))).toMatchObject({
    status: "running",
    owner: { token: "active-owner" },
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
    f.store.finishRun("logged", "log-owner", { status: "succeeded", output: null }),
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
    'import {loopy} from "loopy/graph"; export default loopy("compiled",{input:{payload:"json",values:"number[]"},run:()=>null});',
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

  expect(await Effect.runPromise(f.store.listRuns())).toEqual([]);
});

function registryEntry(home: string, cwd: string, slug: string) {
  return Effect.runPromise(Effect.flatMap(Registry.make(home, cwd), (r) => r.get(slug)));
}
