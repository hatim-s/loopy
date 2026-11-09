import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@loopy/compiler";
import { graphSchema } from "@loopy/contract";
import { LocalExecutor } from "@loopy/runtime/executor";
import { activate } from "@loopy/runtime/host";
import { localDaemon, makeLocalService, openRunStore } from "@loopy/runtime/local";
import { SecretStore } from "@loopy/runtime/os";
import { Effect, Exit, Schema, Scope } from "effect";
import { receiptPath } from "../../runtime/src/executor/receipts";
import { newRun } from "./fixture";
import { fixture } from "./fixtures/executor";
import { approveDemoGraph } from "./fixtures/graphs";
import { waitUntil } from "./fixtures/service-runtime";
import { MemorySqlStore } from "./store-fixture";

test("compiled command parser gets result and prepared input, then code runs through service and daemon", async () => {
  const f = await fixture();
  const source = join(f.workspace, "sequence.ts");
  await writeFile(
    join(f.workspace, "parse.ts"),
    'export default (result, input) => {if (Object.keys(result).sort().join() !== "exitCode,stderr,stdout") {throw new Error("Unexpected parser result fields.");} return {word: result.stdout.trim(), operand: input.args[0]};};',
  );
  await writeFile(
    join(f.workspace, "code.ts"),
    'export default (input, context) => {context.log("code", input); return {message: input.word + " " + input.operand};};',
  );
  await writeFile(
    source,
    `import {loopy, defineCommand, code, sh} from "loopy";
const echo = defineCommand({key: "fixture.echo", program: "printf", parse: "./parse.ts", positionals: [{name: "word"}]}, {kind: "record", fields: {word: "string", operand: "string"}});
export default loopy("sequence", {input: {}, run: () => {sh.exec(["printf", "raw"], {label: "raw"}); const raw = echo({args: ["hello"]}); return code("greet", {in: {word: raw.get("word"), operand: raw.get("operand")}, out: {kind: "record", fields: {message: "string"}}, module: "./code.ts"});}});`,
  );
  const compiled = await Effect.runPromise(compile(source));

  if (!compiled.ok) {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }

  const home = join(f.root, "home");
  const scope = Scope.makeUnsafe();

  try {
    const store = await Effect.runPromise(
      openRunStore(home).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    const service = makeLocalService({ home, store, clock: { now: Date.now } });

    const daemon = await Effect.runPromise(
      localDaemon({
        home,
        cwd: f.workspace,
        store,
        concurrency: 1,
        port: 0,
        assets: join(f.workspace, "assets"),
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    await Effect.runPromise(
      service.putLoopy("sequence", {
        graph: compiled.graph,
        revision: compiled.revision,
        bundles: compiled.bundles,
        replace: false,
        source: { path: source, workspace: f.workspace },
      }),
    );
    const run = await Effect.runPromise(service.startRun("sequence", {}, f.workspace));
    await writeFile(
      join(f.workspace, "code.ts"),
      'export default () => ({message: "replacement"});',
    );
    const replacement = await Effect.runPromise(compile(source));

    if (!replacement.ok) {
      throw new Error(JSON.stringify(replacement.diagnostics));
    }

    await Effect.runPromise(
      service.putLoopy("sequence", {
        graph: replacement.graph,
        revision: replacement.revision,
        bundles: replacement.bundles,
        replace: false,
        source: { path: source, workspace: f.workspace },
      }),
    );
    expect(replacement.revision).not.toBe(compiled.revision);
    expect((await Effect.runPromise(store.getRun(run.id)))?.revision).toBe(compiled.revision);
    await Effect.runPromise(Effect.forkIn(daemon.run, scope));
    await Effect.runPromise(
      waitUntil(Effect.map(store.getRun(run.id), (stored) => stored?.status === "succeeded")),
    );
    const snapshot = await Effect.runPromise(service.runSnapshot(run.id));
    expect(snapshot.run).toMatchObject({ status: "succeeded", output: { message: "hello hello" } });
    expect(snapshot.nodeRuns.map((node) => node.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(snapshot.nodeRuns.map((node) => node.attempt)).toEqual([1, 1, 1, 1]);
    expect(snapshot.nodeRuns.every((node) => node.key.scope.length === 0)).toBe(true);
    expect(await Effect.runPromise(store.getLogs(run.id, 0, 200))).toContainEqual(
      expect.objectContaining({ message: "code", data: { word: "hello", operand: "hello" } }),
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

for (const failure of ["timeout", "output_limit", "nonzero"] as const) {
  test(`bundle ${failure} masks escaped secrets before storing logs, node failures and receipts`, async () => {
    const f = await fixture();
    const secret = 'alpha"beta';
    const escaped = JSON.stringify(secret).slice(1, -1);
    await Effect.runPromise(new SecretStore(f.home).set("TOKEN", secret));

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: ["TOKEN"],
      bundlePath: () => f.bundle,
    });

    const ending =
      failure === "timeout"
        ? "await Bun.sleep(10000);"
        : failure === "output_limit"
          ? 'process.stdout.write("x".repeat(3 * 1024 * 1024));'
          : "process.exit(2);";

    await writeFile(
      f.bundle,
      `const secret = process.env.TOKEN; const escaped = JSON.stringify(secret).slice(1,-1); process.stderr.write(JSON.stringify({message: escaped, data: {nested: [escaped]}}) + "\\n"); process.stdout.write(JSON.stringify({escaped}) + "\\n"); process.stderr.write('{"message":"partial","data":"' + JSON.stringify(escaped).slice(1,-1)); ${ending}`,
    );
    const graph = structuredClone(approveDemoGraph);
    const node = graph.nodes[0];

    if (node?.kind !== "code") {
      throw new Error("Expected code fixture.");
    }

    node.module.bundleHash = "a".repeat(64);
    node.timeout = 500;
    node.retry = { attempts: 1, retryOnExit: false };
    const store = new MemorySqlStore();
    await Effect.runPromise(store.createRun({ ...newRun(), input: { subject: "test" } }));

    const outcome = await Effect.runPromise(
      activate({
        store,
        executor,
        graph: Schema.decodeUnknownSync(graphSchema)(graph),
        runId: "run",
      }),
    );

    expect(outcome.status).toBe("failed");
    const nodes = await Effect.runPromise(store.getNodeRuns("run"));
    expect(nodes[0]).toMatchObject({
      status: "failed",
      error: { code: failure === "output_limit" ? "output_limit" : "execution" },
    });
    const logs = await Effect.runPromise(store.getLogs("run"));
    const key = nodes[0]?.key;

    if (!key) {
      throw new Error("Missing stored execution key.");
    }

    const receipt = await readFile(await Effect.runPromise(receiptPath(f.home, key, 1)), "utf8");

    for (const value of [nodes, logs, outcome, JSON.parse(receipt)]) {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain("alpha");
      expect(serialized).not.toContain(escaped);
      expect(serialized).not.toContain(JSON.stringify(escaped).slice(1, -1));
    }

    expect(logs).toContainEqual(
      expect.objectContaining({ message: "[redacted]", data: { nested: ["[redacted]"] } }),
    );
  });
}

for (const ending of ["timeout", "success"] as const) {
  test(`bundle ${ending} masks a secret nested two JSON levels inside a log string`, async () => {
    const f = await fixture();
    await Effect.runPromise(new SecretStore(f.home).set("TOKEN", 'alpha"beta'));

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: ["TOKEN"],
      bundlePath: () => f.bundle,
    });

    const record =
      'const token = process.env.TOKEN; const record = JSON.stringify({message: "resp", data: JSON.stringify({auth: JSON.stringify({token})})});';

    const tail = {
      timeout: "process.stderr.write(record.slice(0, -2)); await Bun.sleep(10000);",
      success: 'process.stdout.write(record + "\\n" + JSON.stringify({words: 1}) + "\\n");',
    }[ending];

    await writeFile(f.bundle, `${record} ${tail}`);
    const graph = structuredClone(approveDemoGraph);
    const node = graph.nodes[0];

    if (node?.kind !== "code") {
      throw new Error("Expected code fixture.");
    }

    node.module.bundleHash = "a".repeat(64);
    node.timeout = 500;
    node.retry = { attempts: 1, retryOnExit: false };
    const runs = new MemorySqlStore();
    await Effect.runPromise(runs.createRun({ ...newRun(), input: { subject: "test" } }));

    const outcome = await Effect.runPromise(
      activate({
        store: runs,
        executor,
        graph: Schema.decodeUnknownSync(graphSchema)(graph),
        runId: "run",
      }),
    );

    const nodes = await Effect.runPromise(runs.getNodeRuns("run"));
    expect(nodes[0]?.status).toBe(ending === "success" ? "succeeded" : "failed");
    const logs = await Effect.runPromise(runs.getLogs("run"));
    const key = nodes[0]?.key;

    if (!key) {
      throw new Error("Missing stored execution key.");
    }

    const receipt = JSON.parse(
      await readFile(await Effect.runPromise(receiptPath(f.home, key, 1)), "utf8"),
    );

    const events = await Effect.runPromise(runs.events(0, 1000));

    for (const value of [nodes, logs, events, outcome, receipt]) {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain("alpha");
      expect(serialized).not.toContain("beta");
    }

    expect(JSON.stringify(logs)).toContain("[redacted]");
  });
}

for (const ending of ["success", "timeout", "output_limit", "nonzero"] as const) {
  test(`bundle ${ending} masks secrets printed as plain text on stdout and stderr`, async () => {
    const f = await fixture();
    const secrets = { TOKEN: 'alpha"beta', WINDOWS: "C:\\new", MULTILINE: "line1\nline2" };
    const store = new SecretStore(f.home);

    for (const [name, value] of Object.entries(secrets)) {
      await Effect.runPromise(store.set(name, value));
    }

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: Object.keys(secrets),
      bundlePath: () => f.bundle,
    });

    const tail = {
      success: "console.log(JSON.stringify({words: 1}));",
      timeout: "await Bun.sleep(10000);",
      output_limit: 'process.stdout.write("x".repeat(3 * 1024 * 1024));',
      nonzero: "process.exit(2);",
    }[ending];

    await writeFile(
      f.bundle,
      `const escaped = JSON.stringify(process.env.TOKEN).slice(1,-1); console.log(escaped); console.error(escaped); console.log('say "hi there"'); console.log('token="' + process.env.WINDOWS + '"'); console.error('token="' + process.env.WINDOWS + '"'); console.error(process.env.MULTILINE); ${tail}`,
    );
    const graph = structuredClone(approveDemoGraph);
    const node = graph.nodes[0];

    if (node?.kind !== "code") {
      throw new Error("Expected code fixture.");
    }

    node.module.bundleHash = "a".repeat(64);
    node.timeout = 500;
    node.retry = { attempts: 1, retryOnExit: false };
    const runs = new MemorySqlStore();
    await Effect.runPromise(runs.createRun({ ...newRun(), input: { subject: "test" } }));

    const outcome = await Effect.runPromise(
      activate({
        store: runs,
        executor,
        graph: Schema.decodeUnknownSync(graphSchema)(graph),
        runId: "run",
      }),
    );

    const nodes = await Effect.runPromise(runs.getNodeRuns("run"));
    expect(nodes[0]?.status).toBe(ending === "success" ? "succeeded" : "failed");
    const logs = await Effect.runPromise(runs.getLogs("run"));
    const key = nodes[0]?.key;

    if (!key) {
      throw new Error("Missing stored execution key.");
    }

    const receipt = JSON.parse(
      await readFile(await Effect.runPromise(receiptPath(f.home, key, 1)), "utf8"),
    );

    const events = await Effect.runPromise(runs.events(0, 1000));

    for (const value of [nodes, logs, events, outcome, receipt]) {
      const serialized = JSON.stringify(value);

      for (const fragment of ["alpha", "C:", "line1", "line2"]) {
        expect(serialized).not.toContain(fragment);
      }
    }

    expect(logs).toContainEqual(
      expect.objectContaining({
        message: "stderr",
        data: '[redacted]\ntoken="[redacted]"\n[redacted]\n',
      }),
    );

    if (ending === "success") {
      expect(logs).toContainEqual(
        expect.objectContaining({
          message: "stdout",
          data: '[redacted]\nsay "hi there"\ntoken="[redacted]"\n',
        }),
      );
    }
  });
}
