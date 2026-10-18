import { descriptorCommand } from "../../descriptor.js";
import { parseLs } from "../parse/fs.js";

const rawLs = descriptorCommand({
  namespace: "fs",
  name: "ls",
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
});

const parsedLs = descriptorCommand({
  namespace: "fs",
  name: "ls",
  program: "find",
  parse: parseLs,
  preset: { flags: { maxDepth: 1, minDepth: 1, print0: true } },
  flags: {
    maxDepth: { cli: "-maxdepth", kind: "number" },
    minDepth: { cli: "-mindepth", kind: "number" },
    print0: { cli: "-print0", kind: "boolean", order: 10 },
  },
  positionals: [{ name: "directory", optional: true }],
  flagsAfterPositionals: true,
  prepare: (input) => ({ ...input, args: input.args?.length ? input.args : ["."] }),
});

export const files = {
  /** Lists immediate basenames using find, including hidden entries. .raw runs ls. */
  ls: { raw: rawLs, descriptor: parsedLs.descriptor },
  cat: descriptorCommand({
    namespace: "fs",
    name: "cat",
    program: "cat",
    flags: {
      n: { cli: "-n", kind: "boolean" },
      b: { cli: "-b", kind: "boolean" },
      s: { cli: "-s", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  cp: descriptorCommand({
    namespace: "fs",
    name: "cp",
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
  mv: descriptorCommand({
    namespace: "fs",
    name: "mv",
    program: "mv",
    flags: {
      force: { cli: "-f", kind: "boolean" },
      interactive: { cli: "-i", kind: "boolean" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  rm: descriptorCommand({
    namespace: "fs",
    name: "rm",
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
  mkdir: descriptorCommand({
    namespace: "fs",
    name: "mkdir",
    program: "mkdir",
    flags: {
      parents: { cli: "-p", kind: "boolean" },
      mode: { cli: "-m", kind: "string" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  touch: descriptorCommand({
    namespace: "fs",
    name: "touch",
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
