import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile } from "../src/compiler/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import { receiptPath } from "../src/executor/receipts.js";
import { SYSTEM_CLOCK } from "../src/host/index.js";
import {
  LoopyService,
  localDaemon,
  openRunStore,
  Registry,
  SecretStore,
} from "../src/local/index.js";
import { fixture } from "./fixtures/executor.js";

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
