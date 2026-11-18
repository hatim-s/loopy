import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalExecutor } from "@loopy/runtime/executor";
import { activate } from "@loopy/runtime/host";
import { makeSqliteRunStore } from "@loopy/runtime/store";
import { Effect } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { fixture } from "../../runtime/_tests_/fixtures/executor";
import { onCleanup, runScoped } from "../../runtime/_tests_/fixtures/test-scope";
import { compileOrThrow } from "./fixtures/compile";

test("real parsed git, filesystem, text and redirecting curl executions persist their graph results", async () => {
  const f = await fixture();

  const worktreePath = join(f.workspace, "repo\nline");
  await mkdir(worktreePath);
  const gitEnv = { PATH: process.env.PATH, HOME: f.home, LOOPY_HOME: f.home, LANG: "C.UTF-8" };

  const init = Bun.spawn(["git", "init", "--quiet", f.workspace], {
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await init.exited).toBe(0);

  const initWorktree = Bun.spawn(
    ["git", "init", "--quiet", "--initial-branch=main", worktreePath],
    {
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(await initWorktree.exited).toBe(0);
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

  onCleanup(() => server.stop(true));
  const store = await runScoped(makeSqliteRunStore(":memory:"));

  const source = join(f.workspace, "parsed.ts");
  await writeFile(
    source,
    `import {loopy, git, fs, text, net} from "loopy";
export default loopy("parsed", {input: {}, mode: "full", run: () => {
  const repository = git.revParse({flags: {showToplevel: true}}, {label: "git"});
  const worktrees = git.worktree.list({}, {label: "worktrees", cwd: ${JSON.stringify(worktreePath)}});
  const path = fs.realpath({args: ["words.txt"]}, {label: "filesystem"});
  const counts = text.wc({args: ["words.txt"]}, {label: "text"});
  const response = net.curl({args: [${JSON.stringify(new URL("/redirect", server.url).href)}], flags: {location: true}}, {label: "curl"});
  return {repository, worktrees, path, counts, response};
}});`,
  );
  const compiled = await compileOrThrow(source);

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
    worktrees: [
      {
        path: worktreePath,
        sha: "0".repeat(40),
        branch: "main",
        bare: false,
        detached: false,
        locked: false,
      },
    ],
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
  expect(nodes.slice(0, 5)).toMatchObject([
    { status: "succeeded", output: expected.repository },
    { status: "succeeded", output: expected.worktrees },
    { status: "succeeded", output: expected.path },
    { status: "succeeded", output: expected.counts },
    { status: "succeeded", output: expected.response },
  ]);
  expect(await Effect.runPromise(store.getRun("run"))).toMatchObject({
    status: "succeeded",
    output: expected,
  });
});
