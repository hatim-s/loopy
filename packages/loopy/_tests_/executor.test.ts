import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile } from "../src/compiler/index.js";
import { revision } from "../src/core/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import { bundleStopped, bundleSucceeded } from "../src/executor/protocol.js";
import { receiptPath } from "../src/executor/receipts.js";
import { secretRedactor } from "../src/executor/redact.js";
import { activate, SYSTEM_CLOCK } from "../src/host/index.js";
import { LoopyService, localDaemon, Registry, SecretStore } from "../src/local/index.js";
import { loopy, sh } from "../src/sdk/graph/index.js";
import { openRunStore, SqliteRunStore } from "../src/store/index.js";
import { codeGraph, newRun, until } from "./fixture.js";
import { commandSpec, fixture } from "./fixtures/executor.js";

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
      bundles: compiled.bundles.map((bundle) => Buffer.from(bundle.bytes).toString("base64")),
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
      bundles: replacement.bundles.map((bundle) => Buffer.from(bundle.bytes).toString("base64")),
      replace: false,
      source: { path: source, workspace: f.workspace },
    });
    expect(replacement.revision).not.toBe(compiled.revision);
    expect((await store.getRun(run.id))?.revision).toBe(compiled.revision);
    const running = daemon.run();
    await until(async () => (await store.getRun(run.id))?.status === "succeeded");
    await daemon.stop();
    await running;
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
    `import {LocalExecutor} from ${JSON.stringify(resolve(import.meta.dir, "../src/executor/index.ts"))}; const executor = new LocalExecutor({home: ${JSON.stringify(join(f.root, "home"))}, workspace: ${JSON.stringify(f.workspace)}, mode: "sandbox", secrets: {}, bundlePath: () => ${JSON.stringify(f.bundle)}}); await executor.execute(${JSON.stringify(f.key)}, 1, ${JSON.stringify(f.spec)}, new AbortController().signal);`,
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

test("bundle results redact once, so a secret inside the marker leaves it intact", async () => {
  const f = await fixture();
  await new SecretStore(f.home).set("TOKEN", "a");

  const executor = new LocalExecutor({
    home: f.home,
    workspace: f.workspace,
    mode: "sandbox",
    secrets: Object.fromEntries(["TOKEN"].map((name) => [name, new SecretStore(f.home).get(name)])),
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
      const result = bundleStopped(
        { stdout: "", stderr: record.slice(0, end), exitCode: 1, durationMs: 0 },
        secretRedactor([secret]),
        { code: "output_limit", message: "Capture limit" },
      );

      expect(JSON.stringify(result)).not.toContain("alpha");
    }
  }
});

test("complete log records keep keys and values that end in a secret prefix", () => {
  const record = { message: "status", data: { s: 1, su: 2, sup: 3, kept: "pass" } };

  for (const failure of [undefined, { code: "output_limit" as const, message: "Capture limit" }]) {
    const raw = {
      stdout: JSON.stringify({ ok: true }),
      stderr: `${JSON.stringify(record)}\n`,
      exitCode: 0,
      durationMs: 0,
    };

    const redact = secretRedactor(["supersecret"]);
    const result = failure ? bundleStopped(raw, redact, failure) : bundleSucceeded(raw, redact);

    expect(result.logs[0]).toEqual(record);
  }
});

test("code bundles cannot read siblings, dynamically import, or write outside the workspace", async () => {
  const f = await fixture();
  const sibling = join(f.root, "sibling.ts");
  await writeFile(sibling, 'export default "private";');
  const outside = join(f.root, "outside.txt");
  await writeFile(
    f.bundle,
    `import {readFile, writeFile} from "node:fs/promises";
const results = [];
for (const action of [() => readFile(${JSON.stringify(sibling)}), () => import(${JSON.stringify(sibling)}), () => writeFile(${JSON.stringify(outside)}, "escaped")]) {try {await action(); results.push(true);} catch {results.push(false);}}
process.stdout.write(JSON.stringify(results)+"\\n");`,
  );
  expect(await f.executor.execute(f.key, 1, f.spec, new AbortController().signal)).toEqual({
    kind: "succeeded",
    output: [false, false, false],
    logs: [],
  });
});

test("a missing declared secret persists and reports its stable preparation code", async () => {
  const f = await fixture();
  const store = openRunStore(f.home);
  const registry = new Registry(f.home, f.workspace);
  const graph = loopy("missing-secret", { input: {}, secrets: ["TOKEN"], run: () => null }).graph;
  const rev = await revision(graph);
  await registry.save({
    graph,
    revision: rev,
    bundles: [],
    replace: false,
    source: { path: join(f.workspace, "source.ts"), workspace: f.workspace },
  });
  const service = new LoopyService({ store, registry: () => registry, clock: SYSTEM_CLOCK });
  const run = await service.startRun(graph.name, {}, f.workspace);
  const errors: Error[] = [];

  const daemon = localDaemon({
    home: f.home,
    cwd: f.workspace,
    store,
    port: 0,
    concurrency: 1,
    onError: (error) => errors.push(error),
  });

  const running = daemon.run();

  try {
    await until(async () => (await store.getRun(run.id))?.status === "failed");
    expect((await store.getRun(run.id))?.error).toBe(
      "[missing_secret] No stored secret 'TOKEN'. Use loopy secrets set TOKEN.",
    );
    expect(await service.runSnapshot(run.id)).toMatchObject({
      run: { error: "[missing_secret] No stored secret 'TOKEN'. Use loopy secrets set TOKEN." },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "missing_secret",
      message: "No stored secret 'TOKEN'. Use loopy secrets set TOKEN.",
    });
  } finally {
    await daemon.stop();
    await running;
    store.close();
  }
});

for (const mode of ["sandbox", "full"] as const) {
  test(`${mode} bundle cannot read, replace, remove or create daemon receipts`, async () => {
    const f = await fixture();
    const receipt = await receiptPath(f.home, f.key, 1);
    await writeFile(
      f.bundle,
      `import {readFile, writeFile, unlink, readdir} from "node:fs/promises";
const path = ${JSON.stringify(receipt)}; const results = [];
for (const action of [() => readdir(${JSON.stringify(f.home)}), () => readFile(path), () => writeFile(path,"forged"), () => unlink(path), () => writeFile(path + ".forged", "fake")]) {try {await action(); results.push(true);} catch {results.push(false);}}
process.stdout.write(JSON.stringify(results)+"\\n");`,
    );

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode,
      secrets: {},
      bundlePath: () => f.bundle,
    });

    const result = await executor.execute(f.key, 1, f.spec, new AbortController().signal);
    expect(result).toEqual({
      kind: "succeeded",
      output: [false, false, false, false, false],
      logs: [],
    });
    expect(await executor.lookup(f.key, 1)).toEqual({
      kind: "finished",
      executionKey: f.key,
      attempt: 1,
      result,
    });
  });
}

for (const mode of ["sandbox", "full"] as const) {
  test(`${mode} commands cannot read or replace daemon receipts`, async () => {
    const f = await fixture();
    const receipt = await receiptPath(f.home, f.key, 1);

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode,
      secrets: {},
      bundlePath: () => f.bundle,
    });

    const spec = commandSpec([
      "/bin/sh",
      "-c",
      'test ! -r "$1" && ! printf forged > "$1"',
      "probe",
      receipt,
    ]);

    expect(await executor.execute(f.key, 1, spec, new AbortController().signal)).toMatchObject({
      kind: "succeeded",
      output: { exitCode: 0 },
    });
    expect(await executor.lookup(f.key, 1)).toMatchObject({
      kind: "finished",
      result: { kind: "succeeded" },
    });
  });
}

for (const stderr of ["", `${"x".repeat(600)}last failure`]) {
  test("command exit errors omit empty stderr and retain its last 500 characters", async () => {
    const f = await fixture();
    const spec = commandSpec(["/bin/sh", "-c", 'printf %s "$1" >&2; exit 1', "probe", stderr]);

    const result = await f.executor.execute(f.key, 1, spec, new AbortController().signal);
    expect(result).toMatchObject({
      kind: "failed",
      exitCode: 1,
      error: { code: "exit" },
    });

    if (result.kind === "failed") {
      if (stderr) {
        expect(result.error.message).toContain(stderr.slice(-500));
      } else {
        expect(result.error.message).not.toContain(": ");
      }

      expect(result.error.message).not.toContain("x".repeat(501));
    }
  });
}

for (const accepted of [false, true]) {
  test(`declared successful exit codes are checked before parser execution, accepted=${accepted}`, async () => {
    const f = await fixture();
    await writeFile(
      f.bundle,
      'const {result} = await Bun.stdin.json(); process.stdout.write(JSON.stringify({parsedExit: result.exitCode}) + "\\n");',
    );
    const spec = commandSpec(["/bin/sh", "-c", "exit 2"]);

    if (spec.kind !== "command") {
      throw new Error("Expected command spec");
    }

    spec.okExitCodes = accepted ? [0, 2] : [0];
    spec.parse = { bundleHash: "a".repeat(64), input: {} };
    const result = await f.executor.execute(f.key, 1, spec, new AbortController().signal);
    expect(result).toMatchObject(
      accepted
        ? { kind: "succeeded", output: { parsedExit: 2 } }
        : { kind: "failed", error: { code: "exit" }, exitCode: 2 },
    );
  });
}

test("parser execution failures propagate to the stored graph node and run", async () => {
  const f = await fixture();
  await writeFile(f.bundle, 'throw new Error("Parser rejected command output");');

  const graph = loopy("parser-failure", {
    input: {},
    run: () => sh(["printf", "raw"], { retry: { attempts: 1 } }),
  }).graph;

  const node = graph.nodes.find((node) => node.kind === "command");

  if (node?.kind !== "command") {
    throw new Error("Expected command node");
  }

  node.parse = { bundleHash: "a".repeat(64), input: {} };
  const store = new SqliteRunStore(":memory:");
  await store.createRun(newRun());
  expect(await activate({ store, executor: f.executor, graph, runId: "run" })).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Parser rejected command output"),
  });
  expect((await store.getNodeRuns("run"))[0]).toMatchObject({
    status: "failed",
    attempt: 1,
    error: {
      code: "execution",
      message: expect.stringContaining("Parser rejected command output"),
    },
  });
  expect(await store.getLogs("run")).toContainEqual(
    expect.objectContaining({ message: "stdout", data: "raw" }),
  );
});

for (const kind of ["code", "command"] as const) {
  for (const mode of ["sandbox", "full"] as const) {
    for (const ending of ["success", "nonzero", "timeout", "output_limit"] as const) {
      if (kind === "command" && ending === "timeout") {
        continue;
      }

      test(`${kind} ${mode} ${ending} redacts streams, values, diagnostics, stored records and receipts`, async () => {
        const f = await fixture();

        const values = {
          TOKEN: 'alpha"beta',
          WINDOWS: "C:\\new",
          MULTILINE: "line1\nline2",
          NUMBER: "42",
          LONG: `start-${"private".repeat(100)}-end`,
        };

        const secrets = new SecretStore(f.home);

        for (const [name, value] of Object.entries({ ...values, OTHER: "undeclared" })) {
          await secrets.set(name, value);
        }

        const executor = new LocalExecutor({
          home: f.home,
          workspace: f.workspace,
          mode,
          secrets: Object.fromEntries(Object.keys(values).map((name) => [name, secrets.get(name)])),
          bundlePath: () => f.bundle,
        });

        const prelude = `const {TOKEN,WINDOWS,MULTILINE,NUMBER,LONG,OTHER}=process.env; if(OTHER) throw new Error("Undeclared secret exposed"); const escaped=JSON.stringify(TOKEN).slice(1,-1);`;

        const structured =
          kind === "code"
            ? 'process.stderr.write(JSON.stringify({message:escaped,data:{nested:JSON.stringify({auth:JSON.stringify({token:TOKEN})}),number:42,numericSecret:NUMBER}})+"\\n");'
            : "";

        const streams = `process.stdout.write(escaped + '\\nsay "hi there"\\ntoken="' + WINDOWS + '"\\n'); process.stderr.write(escaped + '\\ntoken="' + WINDOWS + '"\\n' + MULTILINE + '\\n' + LONG + '\\n');`;

        const tails = {
          success:
            kind === "code"
              ? 'process.stdout.write("\\n"+JSON.stringify({token:TOKEN,nested:[TOKEN],number:42,numericSecret:NUMBER,other:OTHER??null})+"\\n");'
              : "",
          nonzero: "process.exit(2);",
          timeout:
            "process.stderr.write(JSON.stringify(escaped).slice(1,7)); await Bun.sleep(10000);",
          output_limit: 'process.stdout.write("x".repeat(10 * 1024 * 1024));',
        };

        const script = `${prelude} ${structured} ${streams} ${tails[ending]}`;

        const graph =
          kind === "code"
            ? codeGraph({ kind: "value", type: "json" })
            : loopy("redaction", {
                input: {},
                run: () => sh([process.execPath, "-e", script], { retry: { attempts: 1 } }),
              }).graph;

        const node = graph.nodes[0];

        if (node?.kind === "code") {
          node.timeout = 500;
          node.retry.attempts = 1;
          await writeFile(f.bundle, script);
        }

        const store = new SqliteRunStore(":memory:");

        try {
          await store.createRun(newRun());
          const outcome = await activate({ store, executor, graph, runId: "run" });
          expect(outcome.status).toBe(ending === "success" ? "succeeded" : "failed");
          const nodes = await store.getNodeRuns("run");
          const attempt = nodes[0];

          if (!attempt) {
            throw new Error("Missing stored execution attempt.");
          }

          if (ending !== "success") {
            expect(attempt).toMatchObject({
              status: "failed",
              error: {
                code:
                  ending === "output_limit"
                    ? "output_limit"
                    : kind === "command" && ending === "nonzero"
                      ? "exit"
                      : "execution",
              },
            });
          }

          const logs = await store.getLogs("run");

          const receipt = JSON.parse(
            await readFile(await receiptPath(f.home, attempt.key, 1), "utf8"),
          );

          for (const value of [nodes, logs, outcome, receipt, await store.events(0, 100)]) {
            const text = JSON.stringify(value);

            for (const fragment of ["alpha", "beta", "C:", "line1", "line2", "start-private"]) {
              expect(text).not.toContain(fragment);
            }

            expect(text).not.toContain('"42"');
            expect(text).not.toContain("undeclared");
          }

          if (kind === "code" && ending === "success") {
            expect(attempt).toMatchObject({
              output: {
                token: "[redacted]",
                nested: ["[redacted]"],
                number: 42,
                numericSecret: "[redacted]",
                other: null,
              },
            });
          }

          if (ending === "success") {
            expect(logs).toContainEqual(
              expect.objectContaining({
                message: "stdout",
                data: expect.stringContaining('say "hi there"'),
              }),
            );
          }

          if (kind === "code") {
            expect(logs).toContainEqual(
              expect.objectContaining({
                message: "[redacted]",
                data: expect.objectContaining({ number: 42, numericSecret: "[redacted]" }),
              }),
            );
          }
        } finally {
          store.close();
        }
      });
    }
  }
}

test("redaction handles overlapping values, regex punctuation and truncated secrets", () => {
  expect(secretRedactor(["abc", "abcdef", "a.b?"]).complete("abcdef abc a.b?")).toBe(
    "[redacted] [redacted] [redacted]",
  );
  expect(secretRedactor(["abcdef"]).fragment("prefix abc")).toBe("prefix [redacted]");
});
