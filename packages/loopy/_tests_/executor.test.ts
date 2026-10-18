import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile } from "../src/compiler/index.js";
import { graphSchema } from "../src/contract/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import { bundleResult } from "../src/executor/protocol.js";
import { receiptPath } from "../src/executor/receipts.js";
import { activate, SYSTEM_CLOCK } from "../src/host/index.js";
import {
  LoopyService,
  localDaemon,
  openRunStore,
  Registry,
  SecretStore,
} from "../src/local/index.js";
import { secretRedactor } from "../src/local/secret-redactor.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";
import { fixture } from "./fixtures/executor.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

test("code protocol captures stderr logs and leading stdout, and retains its trusted completion receipt", async () => {
  const f = await fixture();
  await writeFile(
    f.bundle,
    `const input = await Bun.stdin.json(); process.stdout.write("noise\\n"); process.stderr.write(JSON.stringify({message: "hello", data: input}) + "\\n"); process.stdout.write(JSON.stringify({input})+"\\n");`,
  );
  expect(await f.executor.lookup(f.key, 1)).toEqual({ kind: "none" });
  const result = await f.executor.execute(f.key, 1, f.spec, new AbortController().signal);
  expect(result).toEqual({
    kind: "succeeded",
    output: { input: { name: "Hatim" } },
    logs: [
      { message: "hello", data: { name: "Hatim" } },
      { message: "stdout", data: "noise\n" },
    ],
  });
  expect(await f.executor.lookup(f.key, 1)).toMatchObject({ kind: "finished", result });
  expect(await f.executor.execute(f.key, 1, f.spec, new AbortController().signal)).toEqual(result);
});

test("code sandbox cannot read a sibling host file or write outside the workspace in either mode", async () => {
  const f = await fixture();
  const privateFile = join(f.root, "private.ts");
  await writeFile(privateFile, "export default 'private';");
  await writeFile(
    f.bundle,
    `let read = false, write = false, imported = false; try {await Bun.file(${JSON.stringify(privateFile)}).text(); read = true;} catch {} try {await Bun.write(${JSON.stringify(join(f.root, "escape"))}, "bad"); write = true;} catch {} try {await import(${JSON.stringify(privateFile)}); imported = true;} catch {} process.stdout.write(JSON.stringify({read, write, imported})+"\\n");`,
  );

  for (const [index, mode] of ["sandbox", "full"].entries()) {
    if (mode !== "sandbox" && mode !== "full") {
      throw new Error("Unknown mode.");
    }

    const executor = new LocalExecutor({
      home: join(f.root, "home"),
      workspace: f.workspace,
      mode,
      secrets: [],
      bundlePath: () => f.bundle,
    });

    expect(
      await executor.execute(f.key, index + 1, f.spec, new AbortController().signal),
    ).toMatchObject({ kind: "succeeded", output: { read: false, write: false, imported: false } });
  }
});

test("timeout terminates the process group including an inherited grandchild", async () => {
  const f = await fixture();
  await writeFile(
    f.bundle,
    `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "inherit", stderr: "inherit"}); await Bun.write("child.pid", String(child.pid)); setInterval(() => {}, 1000);`,
  );

  const result = await f.executor.execute(
    f.key,
    1,
    { ...f.spec, timeoutMs: 500 },
    new AbortController().signal,
  );

  expect(result).toMatchObject({
    kind: "failed",
    error: { code: "execution", message: expect.stringContaining("timed out") },
  });
  const pid = Number(await readFile(join(f.workspace, "child.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

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
    `import {loopy, defineCommand, code, sh} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))};
const echo = defineCommand({key: "fixture.echo", program: "printf", parse: "./parse.ts", positionals: [{name: "word"}]}, {kind: "record", fields: {word: "string", operand: "string"}});
export default loopy("sequence", {input: {}, run: () => {sh.exec(["printf", "raw"], {label: "raw"}); const raw = echo({args: ["hello"]}); return code("greet", {in: {word: raw.get("word"), operand: raw.get("operand")}, out: {kind: "record", fields: {message: "string"}}, module: "./code.ts"});}});`,
  );
  const compiled = await compile(source);

  if (!compiled.ok) {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }

  const home = join(f.root, "home");
  const store = openRunStore(home);
  const registry = new Registry(home, f.workspace);
  const service = new LoopyService({ store, registry: () => registry, clock: SYSTEM_CLOCK });
  const daemon = localDaemon({ home, cwd: f.workspace, store, concurrency: 1, port: 0 });

  try {
    await service.putLoopy("sequence", {
      graph: compiled.graph,
      revision: compiled.revision,
      bundles: compiled.bundles.map((bundle) => ({
        ...bundle,
        bytes: Buffer.from(bundle.bytes).toString("base64"),
      })),
      replace: false,
      source: { path: source, workspace: f.workspace },
    });
    const run = await service.startRun("sequence", {}, f.workspace);
    await writeFile(
      join(f.workspace, "code.ts"),
      'export default () => ({message: "replacement"});',
    );
    const replacement = await compile(source);

    if (!replacement.ok) {
      throw new Error(JSON.stringify(replacement.diagnostics));
    }

    await service.putLoopy("sequence", {
      graph: replacement.graph,
      revision: replacement.revision,
      bundles: replacement.bundles.map((bundle) => ({
        ...bundle,
        bytes: Buffer.from(bundle.bytes).toString("base64"),
      })),
      replace: false,
      source: { path: source, workspace: f.workspace },
    });
    expect(replacement.revision).not.toBe(compiled.revision);
    expect((await store.getRun(run.id))?.revision).toBe(compiled.revision);
    expect(await daemon.tick()).toEqual({ fired: 0, activated: 1 });
    const snapshot = await service.runSnapshot(run.id);
    expect(snapshot.run).toMatchObject({ status: "succeeded", output: { message: "hello hello" } });
    expect(snapshot.nodeRuns.map((node) => node.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(snapshot.nodeRuns.map((node) => node.attempt)).toEqual([1, 1, 1, 1]);
    expect(snapshot.nodeRuns.every((node) => node.key.scope.length === 0)).toBe(true);
    expect(snapshot.logs).toContainEqual(
      expect.objectContaining({ message: "code", data: { word: "hello", operand: "hello" } }),
    );
  } finally {
    await daemon.stop();
    store.close();
  }
});

test("a worker finishes its receipt after the caller process is killed", async () => {
  const f = await fixture();
  await writeFile(f.bundle, 'await Bun.sleep(400); process.stdout.write("42\\n");');
  const caller = join(f.root, "caller.ts");
  await writeFile(
    caller,
    `import {LocalExecutor} from ${JSON.stringify(resolve(import.meta.dir, "../src/executor/index.ts"))}; const executor = new LocalExecutor({home: ${JSON.stringify(join(f.root, "home"))}, workspace: ${JSON.stringify(f.workspace)}, mode: "sandbox", secrets: [], bundlePath: () => ${JSON.stringify(f.bundle)}}); await executor.execute(${JSON.stringify(f.key)}, 1, ${JSON.stringify(f.spec)}, new AbortController().signal);`,
  );

  const process = Bun.spawn([Bun.which("bun") ?? "bun", "--no-env-file", caller], {
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (
      let index = 0;
      index < 100 && (await f.executor.lookup(f.key, 1)).kind === "none";
      index++
    ) {
      await Bun.sleep(20);
    }

    expect(await f.executor.lookup(f.key, 1)).toMatchObject({ kind: "started" });
    process.kill("SIGKILL");
    await process.exited;
    let receipt = await f.executor.lookup(f.key, 1);

    for (let index = 0; index < 100 && receipt.kind === "started"; index++) {
      await Bun.sleep(20);
      receipt = await f.executor.lookup(f.key, 1);
    }

    expect(receipt).toMatchObject({ kind: "finished", result: { kind: "succeeded", output: 42 } });
  } finally {
    process.kill();
    await process.exited;
  }
});

test("only declared secrets reach bundles and receipts contain redacted results and logs", async () => {
  const f = await fixture();
  const home = join(f.root, "home");
  const secrets = new SecretStore(home);
  secrets.set("LOOPY_EXPOSED", "super-private");
  secrets.set("LOOPY_UNDECLARED", "also-private");
  await writeFile(
    f.bundle,
    'process.stderr.write(JSON.stringify({message: process.env.LOOPY_EXPOSED,data:null})+"\\n"); process.stdout.write(JSON.stringify({token:process.env.LOOPY_EXPOSED,other:process.env.LOOPY_UNDECLARED ?? null})+"\\n");',
  );

  const executor = new LocalExecutor({
    home,
    workspace: f.workspace,
    mode: "sandbox",
    secrets: ["LOOPY_EXPOSED"],
    bundlePath: () => f.bundle,
  });

  expect(await executor.execute(f.key, 1, f.spec, new AbortController().signal)).toMatchObject({
    kind: "succeeded",
    output: { token: "[redacted]", other: null },
    logs: [{ message: "[redacted]", data: null }],
  });
  expect(await readFile(await receiptPath(join(f.root, "home"), f.key, 1), "utf8")).not.toContain(
    "super-private",
  );
});

for (const failure of ["timeout", "output_limit", "nonzero"] as const) {
  test(`bundle ${failure} masks escaped secrets before storing logs, node failures and receipts`, async () => {
    const f = await fixture();
    const secret = 'alpha"beta';
    const escaped = JSON.stringify(secret).slice(1, -1);
    new SecretStore(f.home).set("TOKEN", secret);

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
    node.retry = { attempts: 1, backoff: "exponential", retryOnExit: false };
    const store = new MemoryStore();
    await store.createRun({ ...newRun(), input: { subject: "test" } });

    const outcome = await activate({
      store,
      executor,
      graph: graphSchema.parse(graph),
      runId: "run",
    });

    expect(outcome.status).toBe("failed");
    const nodes = await store.getNodeRuns("run");
    expect(nodes[0]).toMatchObject({
      status: "failed",
      error: { code: failure === "output_limit" ? "output_limit" : "execution" },
    });
    const logs = await store.getLogs("run");
    const key = nodes[0]?.key;

    if (!key) {
      throw new Error("Missing stored execution key.");
    }

    const receipt = await readFile(await receiptPath(f.home, key, 1), "utf8");

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
    new SecretStore(f.home).set("TOKEN", 'alpha"beta');

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
    node.retry = { attempts: 1, backoff: "exponential", retryOnExit: false };
    const runs = new MemoryStore();
    await runs.createRun({ ...newRun(), input: { subject: "test" } });

    const outcome = await activate({
      store: runs,
      executor,
      graph: graphSchema.parse(graph),
      runId: "run",
    });

    const nodes = await runs.getNodeRuns("run");
    expect(nodes[0]?.status).toBe(ending === "success" ? "succeeded" : "failed");
    const logs = await runs.getLogs("run");
    const key = nodes[0]?.key;

    if (!key) {
      throw new Error("Missing stored execution key.");
    }

    const receipt = JSON.parse(await readFile(await receiptPath(f.home, key, 1), "utf8"));
    const events = await runs.events(0, 1000);

    for (const value of [nodes, logs, events, outcome, receipt]) {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain("alpha");
      expect(serialized).not.toContain("beta");
    }

    expect(JSON.stringify(logs)).toContain("[redacted]");
  });
}

test("bundle results redact once, so a secret inside the marker leaves it intact", async () => {
  const f = await fixture();
  new SecretStore(f.home).set("TOKEN", "a");

  const executor = new LocalExecutor({
    home: f.home,
    workspace: f.workspace,
    mode: "sandbox",
    secrets: ["TOKEN"],
    bundlePath: () => f.bundle,
  });

  await writeFile(
    f.bundle,
    'process.stderr.write(JSON.stringify({message: "pet", data: "a cat"}) + "\\n"); process.stdout.write(JSON.stringify("a cat") + "\\n");',
  );
  const result = await executor.execute(f.key, 1, f.spec, new AbortController().signal);
  const receipt = JSON.parse(await readFile(await receiptPath(f.home, f.key, 1), "utf8"));

  expect(result).toEqual({
    kind: "succeeded",
    output: "[redacted] c[redacted]t",
    logs: [{ message: "pet", data: "[redacted] c[redacted]t" }],
  });
  expect(receipt.result).toEqual(result);
  expect(JSON.stringify(receipt)).not.toContain("[red[redacted]");
});

test("truncated bundle records mask secret escapes at every capture boundary", () => {
  const secret = 'alpha"beta';
  const escaped = JSON.stringify(secret).slice(1, -1);
  const nested = JSON.stringify({ auth: JSON.stringify({ token: secret }) });

  for (const record of [
    JSON.stringify({ message: escaped, data: { nested: [escaped] } }),
    JSON.stringify({ message: "resp", data: nested }),
  ]) {
    for (let end = record.indexOf("alpha") + 5; end <= record.length; end++) {
      const result = bundleResult(
        { stdout: "", stderr: record.slice(0, end), exitCode: 1, durationMs: 0 },
        secretRedactor([secret]),
        { code: "output_limit", message: "Capture limit" },
      );

      expect(JSON.stringify(result)).not.toContain("alpha");
    }
  }
});

for (const ending of ["success", "timeout", "output_limit", "nonzero"] as const) {
  test(`bundle ${ending} masks secrets printed as plain text on stdout and stderr`, async () => {
    const f = await fixture();
    const secrets = { TOKEN: 'alpha"beta', WINDOWS: "C:\\new", MULTILINE: "line1\nline2" };
    const store = new SecretStore(f.home);

    for (const [name, value] of Object.entries(secrets)) {
      store.set(name, value);
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
    node.retry = { attempts: 1, backoff: "exponential", retryOnExit: false };
    const runs = new MemoryStore();
    await runs.createRun({ ...newRun(), input: { subject: "test" } });

    const outcome = await activate({
      store: runs,
      executor,
      graph: graphSchema.parse(graph),
      runId: "run",
    });

    const nodes = await runs.getNodeRuns("run");
    expect(nodes[0]?.status).toBe(ending === "success" ? "succeeded" : "failed");
    const logs = await runs.getLogs("run");
    const key = nodes[0]?.key;

    if (!key) {
      throw new Error("Missing stored execution key.");
    }

    const receipt = JSON.parse(await readFile(await receiptPath(f.home, key, 1), "utf8"));
    const events = await runs.events(0, 1000);

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

test("complete log records keep keys and values that end in a secret prefix", () => {
  const record = { message: "status", data: { s: 1, su: 2, sup: 3, kept: "pass" } };

  for (const failure of [undefined, { code: "output_limit" as const, message: "Capture limit" }]) {
    const result = bundleResult(
      {
        stdout: JSON.stringify({ ok: true }),
        stderr: `${JSON.stringify(record)}\n`,
        exitCode: 0,
        durationMs: 0,
      },
      secretRedactor(["supersecret"]),
      failure,
    );

    expect(result.logs[0]).toEqual(record);
  }
});
