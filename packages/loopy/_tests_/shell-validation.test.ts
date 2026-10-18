import { expect, test } from "bun:test";
import { fs, git, text } from "../src/sdk/graph/index.js";
import { capture } from "./fixtures/command-capture.js";

test.each([
  [
    () => git.status.raw({ flags: { z: true, untrackedFiles: "all" } }),
    ["status", "-z", "--untracked-files=all"],
  ],
  [
    () => git.diff.raw({ flags: { staged: true, exitCode: true, quiet: true, unified: 3 } }),
    ["diff", "--exit-code", "--quiet", "-U3", "--staged"],
  ],
  [
    () => git.log.raw({ flags: { until: "yesterday", grep: "fix", firstParent: true } }),
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
  [() => fs.ls.raw({ flags: { one: true, F: true } }), ["-1", "-F"]],
  [
    () => fs.cp({ args: ["a", "b"], flags: { archive: true, noClobber: true, dereference: true } }),
    ["-a", "-n", "-L", "--", "a", "b"],
  ],
  [
    () =>
      fs.find.raw({
        args: ["."],
        flags: { prune: true, path: "vendor", mtime: "+7", size: "+1M" },
      }),
    [".", "-path", "vendor", "-mtime", "+7", "-size", "+1M", "-prune"],
  ],
  [
    () => text.grep.raw({ flags: { q: true, w: true, o: true, A: 1, B: 2, C: 3 } }),
    ["-q", "-w", "-o", "-A", "1", "-B", "2", "-C", "3"],
  ],
] as const)("added shell flags preserve their CLI spelling: %#", async (run, expected) => {
  const { executor, result } = await capture(run);
  expect(result.status).toBe("succeeded");
  expect(executor.calls[0]?.args).toEqual([...expected]);
});

test("jq rejects malformed named pairs before execution", async () => {
  // @ts-expect-error JavaScript callers can supply non-string named values.
  const { executor, result } = await capture(() => text.jq.raw({ flags: { arg: { count: 2 } } }));
  expect(result).toEqual({
    status: "failed",
    error: "Flag '--arg' requires string values. Supply a record of strings.",
  });
  expect(executor.calls).toEqual([]);
});

test.each(["e", "f"] as const)("parsed grepCount rejects -%s before execution", async (flag) => {
  const flags = flag === "e" ? { e: "pattern" } : { f: "patterns.txt" };

  const { executor, result } = await capture(() => {
    // @ts-expect-error JavaScript callers can supply flags that change operand interpretation.
    text.grepCount({ args: ["one", "two"], flags });
  });

  expect(result).toEqual({
    status: "failed",
    error: `Flag '${flag}' changes the parsed output format. Use .raw() to supply this flag.`,
  });
  expect(executor.calls).toEqual([]);
});

test("raw grepCount keeps explicit patterns and pattern files", async () => {
  const { executor, result } = await capture(() => {
    text.grepCount.raw({ args: ["one", "two"], flags: { e: "pattern" } });
    text.grepCount.raw({ args: ["one", "two"], flags: { f: "patterns.txt" } });
  });

  expect(result.status).toBe("succeeded");
  expect(executor.calls.map(({ args }) => args)).toEqual([
    ["-e", "pattern", "--", "one", "two"],
    ["-f", "patterns.txt", "--", "one", "two"],
  ]);
});

test("parsed realpath requires exactly one path before execution", async () => {
  const missing = await capture(() => {
    // @ts-expect-error JavaScript callers can omit the required path.
    fs.realpath();
  });

  const empty = await capture(() => {
    // @ts-expect-error JavaScript callers can supply no paths.
    fs.realpath({ args: [] });
  });

  const multiple = await capture(() => {
    // @ts-expect-error JavaScript callers can supply several paths.
    fs.realpath({ args: ["one", "two"] });
  });

  for (const { executor, result } of [missing, empty, multiple]) {
    expect(result).toEqual({
      status: "failed",
      error:
        "Command 'fs.realpath' expected 1 to 1 positional arguments. Supply args with the expected count.",
    });
    expect(executor.calls).toEqual([]);
  }
});

test("raw realpath keeps variadic paths", async () => {
  const { executor, result } = await capture(() => fs.realpath.raw({ args: ["one", "two"] }));
  expect(result.status).toBe("succeeded");
  expect(executor.calls[0]?.args).toEqual(["one", "two"]);
});
