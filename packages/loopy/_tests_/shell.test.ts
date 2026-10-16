import { expect, test } from "bun:test";
import { MemoryRunStore } from "../src/runtime/index.js";
import { archive, fs, git, loopy, net, sh, text } from "../src/sdk/index.js";
import { startLoopy } from "../src/sdk/run.js";
import { FakeExecutor } from "./engine-fixture.js";

test("typed shell calls record exact argv and command step identities", async () => {
  const executor = new FakeExecutor();
  const store = new MemoryRunStore();

  const definition = loopy({
    name: "shell",
    run: async () => {
      await git.status({ flags: { porcelain: "v2", branch: true } });
      await git.log({ flags: { format: "%H%x00%s", maxCount: 5 } });
      await git.worktree.list({ flags: { porcelain: true } });
      await fs.find({ args: ["."], flags: { name: "*.ts", print0: true } });
      await text.grep({ args: ["TODO", "src"], flags: { n: true, r: true } });
      await fs.cp({
        args: ["one", "two", "destination"],
        flags: { recursive: true, force: false },
      });
      await sh.run("git log --oneline -5");
      await sh.exec(["printf", "%s", "hello world"], {
        stdin: "input",
        cwd: "/tmp",
        env: { LANG: "C" },
        timeout: "2s",
      });
      await net.curl({
        flags: { header: ["Accept: application/json", "X-Test: yes"] },
        args: ["https://example.com"],
      });

      return archive.tar({ flags: { list: true, file: "test.tar" } });
    },
  });

  expect(
    await startLoopy({
      store,
      executor,
      loopy: definition,
      input: {},
      runId: "shell",
      bundleHash: "",
      cwd: "/workspace",
    }),
  ).toMatchObject({ status: "succeeded" });
  expect(executor.calls.map(({ program, args }) => [program, ...args])).toEqual([
    ["git", "status", "--porcelain=v2", "--branch"],
    ["git", "log", "--format=%H%x00%s", "--max-count=5"],
    ["git", "worktree", "list", "--porcelain"],
    ["find", ".", "-name", "*.ts", "-print0"],
    ["grep", "-n", "-r", "--", "TODO", "src"],
    ["cp", "-R", "--", "one", "two", "destination"],
    ["git", "log", "--oneline", "-5"],
    ["printf", "%s", "hello world"],
    ["curl", "-H", "Accept: application/json", "-H", "X-Test: yes", "https://example.com"],
    ["tar", "-t", "-f", "test.tar"],
  ]);
  expect(executor.calls[7]).toMatchObject({ stdin: "input", cwd: "/tmp", env: { LANG: "C" } });
  expect((await store.getSteps("shell")).map(({ key, kind }) => [key, kind])).toEqual([
    ["git.status", "command"],
    ["git.log", "command"],
    ["git.worktree.list", "command"],
    ["fs.find", "command"],
    ["text.grep", "command"],
    ["fs.cp", "command"],
    ["sh.run", "command"],
    ["sh.exec", "command"],
    ["net.curl", "command"],
    ["archive.tar", "command"],
  ]);
});

test("sh.run rejects shell operators with the parser's actionable error", async () => {
  const executor = new FakeExecutor();

  const result = await startLoopy({
    store: new MemoryRunStore(),
    executor,
    loopy: loopy({ name: "pipe", run: () => sh.run("cat file | grep TODO") }),
    input: {},
    runId: "pipe",
    bundleHash: "",
    cwd: "/workspace",
  });

  expect(result).toEqual({
    status: "failed",
    error: "Unsupported shell character '|'. Pass stdin or use separate commands instead.",
  });
  expect(executor.calls).toEqual([]);
});

function compileOnlyChecks() {
  // @ts-expect-error Only declared flags are accepted.
  git.status({ flags: { typo: true } });
  // @ts-expect-error Number flags retain their value type.
  git.log({ flags: { maxCount: "5" } });
  // @ts-expect-error Enum flags retain literal choices.
  git.status({ flags: { porcelain: "v3" } });
  // @ts-expect-error Variadic arguments remain strings.
  fs.cp({ args: [1, 2] });
  // @ts-expect-error Repeated flags require an array.
  net.curl({ flags: { header: "X-Test: yes" } });
}

void compileOnlyChecks;
