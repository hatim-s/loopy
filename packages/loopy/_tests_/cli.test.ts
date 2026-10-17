import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { localDaemon, openRunStore, Registry, readDaemonFile } from "../src/local/index.js";
import { cli, fixture, object, roots } from "./cli-fixture.js";

const daemons: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function graphFixture(name = "compiled") {
  const f = fixture(name, "run: () => null");
  writeFileSync(
    f.file,
    `import { loopy, log } from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))}; export default loopy({name:${JSON.stringify(name)}, input: {count: "number"}, run: ({input}) => {log("ready"); return input.get("count");}});`,
  );
  const store = openRunStore(f.home);
  const daemon = localDaemon({ ...f, store, concurrency: 4, port: 0 });
  daemon.start();
  daemons.push({
    async stop() {
      await daemon.stop();
      store.close();
    },
  });

  return { ...f, store };
}

test("save posts a compiled graph and graph prints the same redacted view by file and name", async () => {
  const f = graphFixture();
  const saved = await cli(f, "save", f.file);
  expect(saved).toMatchObject({ code: 0, stderr: "" });
  const view = object(saved.stdout);
  expect(view.name).toBe("compiled");
  expect(object((await cli(f, "graph", "compiled")).stdout)).toEqual(view);
  expect(object((await cli(f, "graph", f.file)).stdout)).toEqual(view);
  const text = await cli(f, "graph", "compiled", "--format", "text");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("0:log log [next -> 1:join]");
  const entry = new Registry(f.home, f.cwd).get("compiled");
  expect(entry).toMatchObject({
    version: 2,
    graph: { name: "compiled" },
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    bundles: [],
  });
  expect(entry).not.toHaveProperty("bundleHash");
});

test("HTTP commands queue schema-validated graph runs and pin the saved revision", async () => {
  const f = graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  expect((await cli(f, "run", "compiled", "--count", "bad")).code).toBe(1);
  expect(await f.store.listRuns()).toEqual([]);
  const queued = await cli(f, "run", "compiled", "--count", "2");
  expect(queued).toMatchObject({ code: 0, stderr: "" });
  const run = object(queued.stdout);
  expect(run).toMatchObject({ status: "queued", input: { count: 2 } });
  expect(await f.store.getRun(String(run.id))).toMatchObject({
    revision: new Registry(f.home, f.cwd).get("compiled").revision,
  });
  expect(object((await cli(f, "inspect", String(run.id))).stdout).run).toMatchObject({
    id: run.id,
  });
  expect(object((await cli(f, "cancel", String(run.id))).stdout)).toMatchObject({
    status: "cancelled",
  });
});

test("save rejects another source until --replace and locates absolute files beside their source", async () => {
  const f = graphFixture();
  expect((await cli(f, "save", f.file)).code).toBe(0);
  const other = join(f.cwd, "other.ts");
  writeFileSync(other, await Bun.file(f.file).text());
  const rejected = await cli(f, "save", other);
  expect(rejected.stderr).toContain("belongs to another source");
  expect((await cli(f, "save", other, "--replace")).code).toBe(0);
  const caller = join(f.cwd, "caller");
  mkdirSync(caller);
  expect((await cli({ ...f, cwd: caller }, "save", other)).code).toBe(0);
  expect(new Registry(f.home, f.cwd).get("compiled").source).toBe(other);
});

test("compiler diagnostics include locations and do not create registry entries", async () => {
  const f = graphFixture();
  writeFileSync(
    f.file,
    `import {loopy} from "loopy/graph"; export default loopy({name:"bad",input:{},run:async()=>1});`,
  );
  const result = await cli(f, "save", f.file);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("[synchronous_run]");
  expect(new Registry(f.home, f.cwd).list()).toEqual([]);
});

test("CLI rejects invalid graph formats and short leases", async () => {
  const f = graphFixture();
  expect((await cli(f, "graph", f.file, "--format", "svg")).stderr).toContain(
    "--format json or --format text",
  );
  expect((await cli(f, "runs", "--lease-ms", "999")).stderr).toContain("at least 1000");
});

test("save starts the daemon on demand and leaves artifact writes to the service", async () => {
  const f = fixture("on-demand", "run: () => null");
  writeFileSync(
    f.file,
    `import {loopy} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))}; export default loopy({name:"on-demand",input:{},run:()=>null});`,
  );
  const [result, concurrent] = await Promise.all([cli(f, "save", f.file), cli(f, "save", f.file)]);
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
  expect(new Registry(f.home, f.cwd).get("on-demand").graph.name).toBe("on-demand");
});

test("list and schedules use the caller workspace when the daemon started elsewhere", async () => {
  const f = graphFixture();
  const other = join(f.cwd, "other");
  mkdirSync(other);
  const file = join(other, "other.ts");
  writeFileSync(
    file,
    `import {loopy} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))}; export default loopy({name:"other",input:{},run:()=>null});`,
  );
  const caller = { ...f, cwd: other };
  expect((await cli(caller, "save", file, "--cwd", other)).code).toBe(0);
  expect(JSON.parse((await cli(caller, "list")).stdout)).toMatchObject([{ slug: "other" }]);
  expect((await cli(caller, "schedule", "other", "--cron", "* * * * *")).code).toBe(0);
});

test("types uses the daemon's command-help endpoint and writes the returned source", async () => {
  const f = graphFixture();
  const result = await cli(f, "types", "git", "--out", "git.ts");
  expect(result.code).toBe(0);
  expect(await Bun.file(join(f.cwd, "git.ts")).text()).toContain("defineCommand");
});

test("an absolute source in another project is registered beside that source", async () => {
  const source = graphFixture("external-source");
  const caller = fixture("unrelated-caller", "run: () => null");
  const saved = await cli({ ...caller, home: source.home }, "save", source.file);
  expect(saved).toMatchObject({ code: 0, stderr: "" });
  expect(new Registry(source.home, source.cwd).get("external-source").source).toBe(source.file);
  expect(new Registry(source.home, caller.cwd).list()).toEqual([]);
});
