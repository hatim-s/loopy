import { expect, test } from "bun:test";
import { MemoryRunStore } from "../src/runtime/index.js";
import { archive, type CommandResult, fs, git, loopy, net, sh, text } from "../src/sdk/index.js";
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

async function capture(run: () => Promise<CommandResult | void>) {
  const executor = new FakeExecutor();

  const result = await startLoopy({
    store: new MemoryRunStore(),
    executor,
    input: {},
    runId: "capture",
    bundleHash: "",
    cwd: "/workspace",
    loopy: loopy({
      name: "capture",
      run: async () => {
        await run();

        return null;
      },
    }),
  });

  return { executor, result };
}

test("zip exclusions trail archive operands", async () => {
  const { executor, result } = await capture(() =>
    archive.zip({
      args: ["test.zip", "src/a.ts"],
      flags: { exclude: "*.txt" },
    }),
  );

  expect(result.status).toBe("succeeded");
  expect(executor.calls[0]?.args).toEqual(["test.zip", "src/a.ts", "-x", "*.txt"]);
});

test("find predicates precede actions regardless of caller property order", async () => {
  const { executor, result } = await capture(async () => {
    await fs.find({ args: ["."], flags: { print0: true, name: "*.ts", type: "f" } });
    await fs.find({ args: ["."], flags: { type: "f", name: "*.ts", print0: true } });
    await fs.find({
      args: ["."],
      flags: { exec: ["echo", "{}"], notPath: "*/vendor/*", notName: "*.txt" },
    });
  });

  expect(result.status).toBe("succeeded");
  expect(executor.calls.map(({ args }) => args)).toEqual([
    [".", "-name", "*.ts", "-type", "f", "-print0"],
    [".", "-name", "*.ts", "-type", "f", "-print0"],
    [".", "!", "-name", "*.txt", "!", "-path", "*/vendor/*", "-exec", "echo", "{}", ";"],
  ]);
});

test("git inspection separates revisions from paths", async () => {
  const { executor, result } = await capture(async () => {
    await git.diff({ revisions: ["HEAD~1", "HEAD"], paths: ["src"], flags: { stat: true } });
    await git.log({ revisions: ["main..HEAD"], paths: ["src"], flags: { oneline: true } });
    await git.show({ revisions: ["HEAD"], paths: ["src"], flags: { stat: true } });
    await git.diff({ revisions: ["HEAD~1", "HEAD"] });
  });

  expect(result.status).toBe("succeeded");
  expect(executor.calls.map(({ args }) => args)).toEqual([
    ["diff", "--stat", "HEAD~1", "HEAD", "--", "src"],
    ["log", "--oneline", "main..HEAD", "--", "src"],
    ["show", "--stat", "HEAD", "--", "src"],
    ["diff", "HEAD~1", "HEAD"],
  ]);
});

test("jq named pairs retain separate keys and values", async () => {
  const { executor, result } = await capture(() =>
    text.jq({
      args: ["$name"],
      flags: {
        argjson: { count: "2" },
        arg: { name: "a b", empty: "" },
        rawInput: true,
        slurp: true,
      },
    }),
  );

  expect(result.status).toBe("succeeded");
  expect(executor.calls[0]?.args).toEqual([
    "-s",
    "-R",
    "--arg",
    "name",
    "a b",
    "--arg",
    "empty",
    "",
    "--argjson",
    "count",
    "2",
    "$name",
  ]);
});

test("required positionals reject missing and short JavaScript inputs", async () => {
  // @ts-expect-error JavaScript callers can omit the required input.
  const missing = await capture(() => fs.chmod());
  // @ts-expect-error JavaScript callers can omit required args.
  const empty = await capture(() => fs.chmod({}));
  // @ts-expect-error JavaScript callers can supply too few operands.
  const short = await capture(() => fs.chmod({ args: ["755"] }));

  for (const { result, executor } of [missing, empty, short]) {
    expect(result).toEqual({
      status: "failed",
      error:
        "Command 'fs.chmod' expected at least 2 positional arguments. Supply args with the expected count.",
    });
    expect(executor.calls).toEqual([]);
  }
});

function revisedCompileOnlyChecks() {
  // @ts-expect-error Git revisions and paths use separate fields.
  git.diff({ args: ["HEAD"] });
  // @ts-expect-error Git revisions and paths use separate fields.
  git.log({ args: ["HEAD"] });
  // @ts-expect-error Git revisions and paths use separate fields.
  git.show({ args: ["HEAD"] });
  // @ts-expect-error base64 input is a typed flag, not a bare positional.
  text.base64({ args: ["input"] });
  // @ts-expect-error jq named values must be strings.
  text.jq({ flags: { arg: { count: 2 } } });
  // @ts-expect-error staged is the sole spelling of the index diff flag.
  git.diff({ flags: { cached: true } });
  // @ts-expect-error Decompression uses gzip with decompress.
  archive.gunzip();
}

void revisedCompileOnlyChecks;

test.each([
  [
    () => git.status({ flags: { z: true, untrackedFiles: "all" } }),
    ["status", "-z", "--untracked-files=all"],
  ],
  [
    () => git.diff({ flags: { staged: true, exitCode: true, quiet: true, unified: 3 } }),
    ["diff", "--exit-code", "--quiet", "-U3", "--staged"],
  ],
  [
    () => git.log({ flags: { until: "yesterday", grep: "fix", firstParent: true } }),
    ["log", "--until=yesterday", "--grep=fix", "--first-parent"],
  ],
  [
    () => git.commit({ flags: { noVerify: true, signoff: true, file: "message" } }),
    ["commit", "--no-verify", "--signoff", "-F", "message"],
  ],
  [
    () => git.push({ flags: { dryRun: true, atomic: true, followTags: true } }),
    ["push", "--dry-run", "--atomic", "--follow-tags"],
  ],
  [() => fs.ls({ flags: { one: true, F: true } }), ["-1", "-F"]],
  [
    () => fs.cp({ args: ["a", "b"], flags: { archive: true, noClobber: true, dereference: true } }),
    ["-a", "-n", "-L", "--", "a", "b"],
  ],
  [
    () =>
      fs.find({ args: ["."], flags: { prune: true, path: "vendor", mtime: "+7", size: "+1M" } }),
    [".", "-path", "vendor", "-mtime", "+7", "-size", "+1M", "-prune"],
  ],
  [
    () => text.grep({ flags: { q: true, w: true, o: true, A: 1, B: 2, C: 3 } }),
    ["-q", "-w", "-o", "-A", "1", "-B", "2", "-C", "3"],
  ],
] as const)("added shell flags preserve their CLI spelling: %#", async (run, expected) => {
  const { executor, result } = await capture(run);
  expect(result.status).toBe("succeeded");
  expect(executor.calls[0]?.args).toEqual([...expected]);
});

test("jq rejects malformed named pairs before execution", async () => {
  // @ts-expect-error JavaScript callers can supply non-string named values.
  const { executor, result } = await capture(() => text.jq({ flags: { arg: { count: 2 } } }));
  expect(result).toEqual({
    status: "failed",
    error: "Flag '--arg' requires string values. Supply a record of strings.",
  });
  expect(executor.calls).toEqual([]);
});
