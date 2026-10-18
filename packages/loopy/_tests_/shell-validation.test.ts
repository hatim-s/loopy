import { expect, test } from "bun:test";
import { fs, git, loopy, text } from "../src/sdk/index.js";
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
] as const)("added shell flags preserve their CLI spelling: %#", (run, expected) => {
  const { executor, result } = capture(run);
  expect(result.status).toBe("succeeded");
  expect(executor.calls[0]?.args).toEqual([...expected]);
});

test("jq rejects malformed named pairs during graph construction", () => {
  expect(() =>
    loopy("test", {
      input: {},
      run: () => {
        // @ts-expect-error JavaScript callers can supply non-string named values.
        text.jq.raw({ flags: { arg: { count: 2 } } });
      },
    }),
  ).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "flag_type" }) }),
  );
});

test.each(["e", "f"] as const)("parsed grepCount rejects -%s during graph construction", (flag) => {
  const flags = flag === "e" ? { e: "pattern" } : { f: "patterns.txt" };
  expect(() =>
    loopy("test", {
      input: {},
      run: () => {
        // @ts-expect-error JavaScript callers can supply flags that change operand interpretation.
        text.grepCount({ args: ["one", "two"], flags });
      },
    }),
  ).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "protected_flag" }) }),
  );
});

test("raw grepCount keeps explicit patterns and pattern files", () => {
  const { executor, result } = capture(() => {
    text.grepCount.raw({ args: ["one", "two"], flags: { e: "pattern" } });
    text.grepCount.raw({ args: ["one", "two"], flags: { f: "patterns.txt" } });
  });

  expect(result.status).toBe("succeeded");
  expect(executor.calls.map(({ args }) => args)).toEqual([
    ["-e", "pattern", "--", "one", "two"],
    ["-f", "patterns.txt", "--", "one", "two"],
  ]);
});

test("parsed realpath requires exactly one path during graph construction", () => {
  const cases = [
    // @ts-expect-error JavaScript callers can omit the required path.
    () => fs.realpath(),
    // @ts-expect-error JavaScript callers can supply no paths.
    () => fs.realpath({ args: [] }),
    // @ts-expect-error JavaScript callers can supply several paths.
    () => fs.realpath({ args: ["one", "two"] }),
  ];

  for (const run of cases) {
    expect(() => loopy("test", { input: {}, run })).toThrow(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: "arity" }) }),
    );
  }
});

test("raw realpath keeps variadic paths", () => {
  const { executor, result } = capture(() => fs.realpath.raw({ args: ["one", "two"] }));
  expect(result.status).toBe("succeeded");
  expect(executor.calls[0]?.args).toEqual(["one", "two"]);
});
