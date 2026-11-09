import { expect, test } from "bun:test";
import { defineCommand, loopy, sh, text } from "@loopy/sdk/graph";
import { capture } from "./fixtures/command-capture";

const probe = defineCommand({
  key: "test.probe",
  program: "probe",
  positionalSeparator: true,
  positionals: [{ name: "source" }, { name: "targets", variadic: true }],
  flags: {
    mode: { cli: "--mode", kind: "string", choices: ["fast", "safe"], style: "equals" },
    count: { cli: "-n", kind: "number" },
    quiet: { cli: "-q", kind: "boolean" },
    include: { cli: "-I", kind: "string", repeatable: true, style: "attached" },
  },
});

test("graph command descriptors retain enum, numeric, repeated and positional arguments", () => {
  const f = capture(() =>
    probe({
      args: ["source", "one", "two"],
      flags: { mode: "safe", count: 3, quiet: false, include: ["lib", "src"] },
    }),
  );

  expect(f.result).toMatchObject({ status: "succeeded" });
  expect(f.executor.calls).toEqual([
    {
      program: "probe",
      args: ["--mode=safe", "-n", "3", "-Ilib", "-Isrc", "--", "source", "one", "two"],
    },
  ]);
});

test("JavaScript flag values fail when the graph is built, while references wait for execution", () => {
  const build = (flags: Record<string, string | boolean>) => () =>
    loopy("test", { input: {}, run: () => probe({ args: ["source", "target"], flags }) });

  expect(build({ typo: true })).toThrow(
    "Unknown flag 'typo'. Use an allowed flag: mode, count, quiet, include.",
  );
  expect(build({ mode: "quick" })).toThrow(
    "Flag '--mode' must be one of: fast, safe. Choose an allowed value.",
  );
  expect(build({ count: "3" })).toThrow(
    "Flag '-n' requires a number value. Supply the declared flag type.",
  );

  const graph = loopy("deferred", {
    input: { count: "number" },
    run: ({ input }) => probe({ args: ["source", "target"], flags: { count: input.get("count") } }),
  });

  expect(graph.nodes[0]).toMatchObject({ flags: { count: { ref: "input", path: ["count"] } } });
});

test("platform variants merge and preserve unchanged flags in the recorded descriptor", () => {
  const stat = defineCommand({
    key: "test.stat",
    program: "stat",
    flags: { format: { cli: "-f", kind: "string" }, follow: { cli: "-L", kind: "boolean" } },
    variants: {
      linux: { flags: { format: { cli: "--format", kind: "string", style: "equals" } } },
    },
  });

  const f = capture(() => stat({ flags: { format: "%s", follow: true } }));
  expect(f.executor.calls[0]?.args).toEqual(
    process.platform === "linux" ? ["--format=%s", "-L"] : ["-f", "%s", "-L"],
  );
  expect(
    capture(() => text.base64({ flags: { input: "input", decode: true } })).executor.calls[0]?.args,
  ).toEqual(process.platform === "darwin" ? ["-D", "-i", "input"] : ["-d", "input"]);
});

test("descriptor construction rejects duplicate CLI identities in base and merged platform flags", () => {
  expect(() =>
    defineCommand({
      key: "test.alias",
      program: "probe",
      flags: {
        format: { cli: "--format", kind: "string" },
        alias: { cli: "--format", kind: "string" },
      },
    }),
  ).toThrow("Flags 'format' and 'alias' share CLI option '--format'");
  expect(() =>
    defineCommand({
      key: "test.alias",
      program: "probe",
      flags: { format: { cli: "--format", kind: "string" } },
      variants: { linux: { flags: { alias: { cli: "--format", kind: "string" } } } },
    }),
  ).toThrow("Flags 'format' and 'alias' share CLI option '--format'");
});

test("parsed presets protect CLI identities even after descriptor mutation", () => {
  const flags = {
    format: { cli: "--format", kind: "string" as const },
    alias: { cli: "--other", kind: "string" as const },
  };

  const parsed = defineCommand(
    {
      key: "test.alias",
      program: "probe",
      flags,
      preset: { flags: { format: "machine" } },
      parse: "./parse.ts",
    },
    { kind: "value", type: "string" },
  );

  flags.alias.cli = "--format";
  expect(() =>
    loopy("test", { input: {}, run: () => parsed({ flags: { alias: "custom" } }) }),
  ).toThrow("Flag 'alias' changes the parsed output format. Use .raw()");
});

test("prefixed options keep distinct identities while identical prefixes fail", () => {
  const parsed = defineCommand({
    key: "test.prefixed",
    program: "probe",
    flags: {
      name: { cli: "-name", kind: "string" },
      notName: { cli: "-name", kind: "string", prefix: ["!"] },
    },
    preset: { flags: { name: "machine" } },
  });

  expect(capture(() => parsed({ flags: { notName: "custom" } })).executor.calls[0]?.args).toEqual([
    "-name",
    "machine",
    "!",
    "-name",
    "custom",
  ]);
  expect(() =>
    defineCommand({
      key: "test.prefixed",
      program: "probe",
      flags: {
        name: { cli: "-name", kind: "string", prefix: ["!"] },
        alias: { cli: "-name", kind: "string", prefix: ["!"] },
      },
    }),
  ).toThrow("share CLI option '-name'");
});

test("sh.run rejects shell operators during graph construction", () => {
  expect(() => loopy("test", { input: {}, run: () => sh.run("cat file | grep TODO") })).toThrow(
    "Unsupported shell character '|'. Pass stdin or use separate commands instead.",
  );
});
