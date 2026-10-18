import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile } from "../src/compiler/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import { activate } from "../src/host/index.js";
import { SqliteRunStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";
import { fixture } from "./fixtures/executor.js";

test("real parsed git, filesystem, text and redirecting curl executions persist their graph results", async () => {
  const f = await fixture();

  const init = Bun.spawn(["git", "init", "--quiet", f.workspace], {
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

  const store = new SqliteRunStore(":memory:");

  try {
    const source = join(f.workspace, "parsed.ts");
    await writeFile(
      source,
      `import {loopy, git, fs, text, net} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))};
export default loopy("parsed", {input: {}, mode: "full", run: () => {
  const repository = git.revParse({flags: {showToplevel: true}}, {label: "git"});
  const path = fs.realpath({args: ["words.txt"]}, {label: "filesystem"});
  const counts = text.wc({args: ["words.txt"]}, {label: "text"});
  const response = net.curl({args: [${JSON.stringify(new URL("/redirect", server.url).href)}], flags: {location: true}}, {label: "curl"});
  return {repository, path, counts, response};
}});`,
    );
    const compiled = await compile(source);

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
      secrets: {},
      bundlePath: (hash) => join(f.home, "bundles", `${hash}.js`),
    });

    await store.createRun({ ...newRun(), workspace: f.workspace, revision: compiled.revision });

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

    expect(await activate({ store, executor, graph: compiled.graph, runId: "run" })).toMatchObject({
      status: "succeeded",
      output: expected,
    });
    const nodes = await store.getNodeRuns("run");
    expect(nodes.slice(0, 4)).toMatchObject([
      { status: "succeeded", output: expected.repository },
      { status: "succeeded", output: expected.path },
      { status: "succeeded", output: expected.counts },
      { status: "succeeded", output: expected.response },
    ]);
    expect(await store.getRun("run")).toMatchObject({ status: "succeeded", output: expected });
  } finally {
    store.close();
    server.stop(true);
  }
});
