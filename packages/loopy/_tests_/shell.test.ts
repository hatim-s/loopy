import { expect, test } from "bun:test";
import { archive, fs, git, loopy, net, sh, text } from "../src/sdk/graph/index.js";
import { capture } from "./fixtures/command-capture.js";

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
  const { executor, result } = await capture(() => {
    fs.find.raw({ args: ["."], flags: { print0: true, name: "*.ts", type: "f" } });
    fs.find.raw({ args: ["."], flags: { type: "f", name: "*.ts", print0: true } });
    fs.find.raw({
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
  const { executor, result } = await capture(() => {
    git.diff.raw({ revisions: ["HEAD~1", "HEAD"], paths: ["src"], flags: { stat: true } });
    git.log.raw({ revisions: ["main..HEAD"], paths: ["src"], flags: { oneline: true } });
    git.show({ revisions: ["HEAD"], paths: ["src"], flags: { stat: true } });
    git.diff.raw({ revisions: ["HEAD~1", "HEAD"] });
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
    text.jq.raw({
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

test("required positionals reject missing and short JavaScript inputs at construction", () => {
  const cases = [
    // @ts-expect-error JavaScript callers can omit the required input.
    () => fs.chmod(),
    // @ts-expect-error JavaScript callers can omit required args.
    () => fs.chmod({}),
    // @ts-expect-error JavaScript callers can supply too few operands.
    () => fs.chmod({ args: ["755"] }),
  ];

  for (const run of cases) {
    expect(() => loopy("test", { input: {}, run })).toThrow(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: "arity" }) }),
    );
  }
});

function revisedCompileOnlyChecks() {
  // @ts-expect-error Git revisions and paths use separate fields.
  git.diff.raw({ args: ["HEAD"] });
  // @ts-expect-error Git revisions and paths use separate fields.
  git.log.raw({ args: ["HEAD"] });
  // @ts-expect-error Git revisions and paths use separate fields.
  git.show({ args: ["HEAD"] });
  // @ts-expect-error base64 input is a typed flag, not a bare positional.
  text.base64({ args: ["input"] });
  // @ts-expect-error jq named values must be strings.
  text.jq.raw({ flags: { arg: { count: 2 } } });
  // @ts-expect-error staged is the sole spelling of the index diff flag.
  git.diff.raw({ flags: { cached: true } });
  // @ts-expect-error Decompression uses gzip with decompress.
  archive.gunzip();
}

void revisedCompileOnlyChecks;

test("typed shell graphs retain exact argv, command identities and execution options", () => {
  const f = capture(() => {
    git.status.raw({ flags: { porcelain: "v2", branch: true } });
    git.log.raw({ flags: { format: "%H%x00%s", maxCount: 5 } });
    git.worktree.list.raw({ flags: { porcelain: true } });
    fs.find.raw({ args: ["."], flags: { name: "*.ts", print0: true } });
    text.grep.raw({ args: ["TODO", "src"], flags: { n: true, r: true } });
    fs.cp({ args: ["one", "two", "destination"], flags: { recursive: true, force: false } });
    sh.run("git log --oneline -5");
    sh.exec(["printf", "%s", "hello world"], { stdin: "input", cwd: "/tmp", env: { LANG: "C" } });
    net.curl.raw({
      flags: { header: ["Accept: application/json", "X-Test: yes"] },
      args: ["https://example.com"],
    });
    archive.tar({ flags: { list: true, file: "test.tar" } });
  });

  expect(f.result.status).toBe("succeeded");
  expect(f.executor.calls.map(({ program, args }) => [program, ...args])).toEqual([
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
  expect(f.specs[7]).toMatchObject({ stdin: "input", cwd: "/tmp", env: { LANG: "C" } });
});
