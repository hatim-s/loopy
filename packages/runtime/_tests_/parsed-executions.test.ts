import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@loopy/compiler";
import { Effect, Exit, Scope } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { LocalExecutor } from "../src/executor";
import { activate } from "../src/host";
import { makeSqliteRunStore } from "../src/store";
import { fixture } from "./fixtures/executor";

const scopes: Scope.Closeable[] = [];

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

function fixtureScope() {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);

  return scope;
}

test("real parsed git, filesystem, text and redirecting curl executions persist their graph results", async () => {
  const f = await fixture();

  const init = Bun.spawn(["git", "init", "--quiet", f.workspace], {
    env: { PATH: process.env.PATH, HOME: f.home, LOOPY_HOME: f.home, LANG: "C.UTF-8" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await init.exited).toBe(0);
  await writeFile(join(f.workspace, "words.txt"), "hello world\nsecond line\n");
  const body = "HTTP/1.1 200 body text\n__LOOPY_CURL__inside";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/redirect"
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response(body, { headers: { "X-Loopy": "yes" } });
    },
  });

  const scope = fixtureScope();

  const store = await Effect.runPromise(
    makeSqliteRunStore(":memory:").pipe(Effect.provideService(Scope.Scope, scope)),
  );

  try {
    const source = join(f.workspace, "parsed.ts");
    await writeFile(
      source,
      `import {loopy, git, fs, text, net} from "loopy";
export default loopy("parsed", {input: {}, mode: "full", run: () => {
  const repository = git.revParse({flags: {showToplevel: true}}, {label: "git"});
  const path = fs.realpath({args: ["words.txt"]}, {label: "filesystem"});
  const counts = text.wc({args: ["words.txt"]}, {label: "text"});
  const response = net.curl({args: [${JSON.stringify(new URL("/redirect", server.url).href)}], flags: {location: true}}, {label: "curl"});
  return {repository, path, counts, response};
}});`,
    );
    const compiled = await Effect.runPromise(compile(source));

    if (!compiled.ok) {
      throw new Error(JSON.stringify(compiled.diagnostics));
    }

    for (const bundle of compiled.bundles) {
      await Bun.write(join(f.home, "bundles", `${bundle.bundleHash}.js`), bundle.bytes);
    }

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "full",
      secrets: [],
      bundlePath: (hash) => join(f.home, "bundles", `${hash}.js`),
    });

    await Effect.runPromise(
      store.createRun({ ...newRun(), workspace: f.workspace, revision: compiled.revision }),
    );

    const expected = {
      repository: f.workspace,
      path: join(f.workspace, "words.txt"),
      counts: [{ lines: 2, words: 4, bytes: 24, file: "words.txt" }],
      response: {
        status: 200,
        headers: { "x-loopy": "yes" },
        body,
        sizeDownload: body.length,
        timeTotal: expect.any(Number),
        url: new URL("/final", server.url).href,
      },
    };

    expect(
      await Effect.runPromise(activate({ store, executor, graph: compiled.graph, runId: "run" })),
    ).toMatchObject({
      status: "succeeded",
      output: expected,
    });
    const nodes = await Effect.runPromise(store.getNodeRuns("run"));
    expect(nodes.slice(0, 4)).toMatchObject([
      { status: "succeeded", output: expected.repository },
      { status: "succeeded", output: expected.path },
      { status: "succeeded", output: expected.counts },
      { status: "succeeded", output: expected.response },
    ]);
    expect(await Effect.runPromise(store.getRun("run"))).toMatchObject({
      status: "succeeded",
      output: expected,
    });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    server.stop(true);
  }
});
