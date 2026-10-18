import { expect, test } from "bun:test";
import { defineCommand, loopy, sh } from "../src/sdk/index.js";
import { textDescriptors } from "../src/sdk/shell/text.js";
import { capture } from "./fixtures/command-capture.js";

const probe = defineCommand({
  key: "test.probe",
  program: "probe",
  flags: {
    mode: { cli: "--mode", kind: "string", choices: ["fast", "safe"], style: "equals" },
    count: { cli: "-n", kind: "number" },
    quiet: { cli: "-q", kind: "boolean" },
    include: { cli: "-I", kind: "string", repeatable: true, style: "attached" },
  },
  operands: {
    kind: "positional",
    parts: [{ name: "source" }, { name: "targets", variadic: true }],
    separator: true,
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

test("JavaScript flag values fail during graph construction", () => {
  const cases = [
    // @ts-expect-error JavaScript callers can supply unknown flags.
    [() => probe({ args: ["source", "target"], flags: { typo: true } }), "unknown_flag"],
    // @ts-expect-error JavaScript callers can supply unsupported enum values.
    [() => probe({ args: ["source", "target"], flags: { mode: "quick" } }), "flag_choice"],
    // @ts-expect-error JavaScript callers can supply wrong flag types.
    [() => probe({ args: ["source", "target"], flags: { count: "3" } }), "flag_type"],
  ] as const;

  for (const [run, code] of cases) {
    expect(() => loopy("test", { input: {}, run })).toThrow(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code }) }),
    );
  }
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
  const base64 = defineCommand(textDescriptors.base64);
  expect(
    capture(() => base64({ flags: { input: "input", decode: true } })).executor.calls[0]?.args,
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
  ).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "duplicate_flag" }) }),
  );
  expect(() =>
    defineCommand({
      key: "test.alias",
      program: "probe",
      flags: { format: { cli: "--format", kind: "string" } },
      variants: { linux: { flags: { alias: { cli: "--format", kind: "string" } } } },
    }),
  ).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "duplicate_flag" }) }),
  );
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
  ).toThrow(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: "duplicate_flag" }) }),
  );
});

test("sh.run rejects shell operators during graph construction", () => {
  expect(() => loopy("test", { input: {}, run: () => sh.run("cat file | grep TODO") })).toThrow(
    "Unsupported shell character '|'. Pass stdin or use separate commands instead.",
  );
});
