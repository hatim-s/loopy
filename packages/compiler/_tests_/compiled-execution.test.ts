import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localDaemon, makeLocalService } from "@loopy/runtime/local";
import { openRunStore } from "@loopy/runtime/store";
import { Effect, Scope } from "effect";
import { fixture } from "../../runtime/_tests_/fixtures/executor";
import { fixtureScope } from "../../runtime/_tests_/fixtures/test-scope";
import { eventually } from "../../runtime/_tests_/fixtures/wait";
import { compileOrThrow } from "./fixtures/compile";

test("compiled command parser gets only the command result, then code runs through service and daemon", async () => {
  const f = await fixture();
  const source = join(f.workspace, "sequence.ts");
  await writeFile(
    join(f.workspace, "parse.ts"),
    'export default (...args) => {const [result] = args; if (args.length !== 1 || Object.keys(result).sort().join() !== "exitCode,stderr,stdout") {throw new Error("Unexpected parser arguments.");} return {word: result.stdout.trim()};};',
  );
  await writeFile(
    join(f.workspace, "code.ts"),
    'export default (input, context) => {context.log("code", input); return {message: input.word + "!"};};',
  );
  await writeFile(
    source,
    `import {loopy, defineCommand, code, sh} from "loopy";
const echo = defineCommand({key: "fixture.echo", program: "printf", parse: "./parse.ts", positionals: [{name: "word"}]}, {kind: "record", fields: {word: "string"}});
export default loopy("sequence", {input: {}, run: () => {sh.exec(["printf", "raw"], {label: "raw"}); const raw = echo({args: ["hello"]}); return code("greet", {in: {word: raw.get("word")}, out: {kind: "record", fields: {message: "string"}}, module: "./code.ts"});}});`,
  );
  const compiled = await compileOrThrow(source);

  const home = join(f.root, "home");
  const scope = fixtureScope();

  const store = await Effect.runPromise(
    openRunStore(home).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const service = makeLocalService({ home, store });

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
  await writeFile(join(f.workspace, "code.ts"), 'export default () => ({message: "replacement"});');
  const replacement = await compileOrThrow(source);

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
    eventually(
      "the run to succeed",
      Effect.map(store.getRun(run.id), (stored) => stored?.status === "succeeded"),
    ),
  );
  const snapshot = await Effect.runPromise(service.runSnapshot(run.id));
  expect(snapshot.run).toMatchObject({ status: "succeeded", output: { message: "hello!" } });
  expect(snapshot.nodeRuns.map((node) => node.status)).toEqual([
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  expect(snapshot.nodeRuns.map((node) => node.attempt)).toEqual([1, 1, 1, 1]);
  expect(snapshot.nodeRuns.every((node) => node.key.scope.length === 0)).toBe(true);
  expect(await Effect.runPromise(store.getLogs(run.id, 0, 200))).toContainEqual(
    expect.objectContaining({ message: "code", data: { word: "hello" } }),
  );
});
