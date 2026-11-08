import type { Prepare } from "../../descriptor";
import { builtin } from "../builtin";
import { parseLs } from "../parse/fs";

export const currentDirectory: Prepare = (input) => ({
  ...input,
  args: input.args?.length ? input.args : ["."],
});

const rawLs = {
  program: "ls",
  flags: {
    a: { cli: "-a", kind: "boolean" },
    A: { cli: "-A", kind: "boolean" },
    l: { cli: "-l", kind: "boolean" },
    h: { cli: "-h", kind: "boolean" },
    R: { cli: "-R", kind: "boolean" },
    t: { cli: "-t", kind: "boolean" },
    S: { cli: "-S", kind: "boolean" },
    d: { cli: "-d", kind: "boolean" },
    one: { cli: "-1", kind: "boolean" },
    F: { cli: "-F", kind: "boolean" },
  },
  positionals: [{ name: "paths", optional: true, variadic: true }],
  positionalSeparator: true,
} as const;

const parsedLs = {
  program: "find",
  preset: { flags: { maxDepth: 1, minDepth: 1, print0: true } },
  flags: {
    maxDepth: { cli: "-maxdepth", kind: "number" },
    minDepth: { cli: "-mindepth", kind: "number" },
    print0: { cli: "-print0", kind: "boolean", order: 10 },
  },
  positionals: [{ name: "directory", optional: true }],
  flagsAfterPositionals: true,
} as const;

export const files = {
  ls: builtin(parsedLs, {
    parse: parseLs,
    out: { kind: "value", type: "string[]" },
    prepare: currentDirectory,
    raw: rawLs,
  }),
  cat: builtin({
    program: "cat",
    flags: {
      n: { cli: "-n", kind: "boolean" },
      b: { cli: "-b", kind: "boolean" },
      s: { cli: "-s", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  cp: builtin({
    program: "cp",
    flags: {
      recursive: { cli: "-R", kind: "boolean" },
      force: { cli: "-f", kind: "boolean" },
      interactive: { cli: "-i", kind: "boolean" },
      preserve: { cli: "-p", kind: "boolean" },
      archive: { cli: "-a", kind: "boolean" },
      noClobber: { cli: "-n", kind: "boolean" },
      dereference: { cli: "-L", kind: "boolean" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [
      {
        name: "sources",
        variadic: true,
      },
    ],
    positionalSeparator: true,
  }),
  mv: builtin({
    program: "mv",
    flags: {
      force: { cli: "-f", kind: "boolean" },
      interactive: { cli: "-i", kind: "boolean" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  rm: builtin({
    program: "rm",
    flags: {
      recursive: { cli: "-r", kind: "boolean" },
      force: { cli: "-f", kind: "boolean" },
      interactive: { cli: "-i", kind: "boolean" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  mkdir: builtin({
    program: "mkdir",
    flags: {
      parents: { cli: "-p", kind: "boolean" },
      mode: { cli: "-m", kind: "string" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  touch: builtin({
    program: "touch",
    flags: {
      access: { cli: "-a", kind: "boolean" },
      modify: { cli: "-m", kind: "boolean" },
      noCreate: { cli: "-c", kind: "boolean" },
      reference: { cli: "-r", kind: "string" },
      time: { cli: "-t", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
};
