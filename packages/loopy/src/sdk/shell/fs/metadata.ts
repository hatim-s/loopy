import { defineCommand } from "../../define-command.js";

export const metadata = {
  find: defineCommand({
    namespace: "fs",
    name: "find",
    program: "find",
    flags: {
      name: { cli: "-name", kind: "string" },
      iname: { cli: "-iname", kind: "string" },
      type: { cli: "-type", kind: "string" },
      maxDepth: { cli: "-maxdepth", kind: "number" },
      minDepth: { cli: "-mindepth", kind: "number" },
      print0: { cli: "-print0", kind: "boolean" },
      empty: { cli: "-empty", kind: "boolean" },
      delete: { cli: "-delete", kind: "boolean" },
      printf: { cli: "-printf", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    flagsAfterPositionals: true,
    variants: {
      darwin: {
        flags: {
          printf: {
            cli: "-printf",
            kind: "string",
            supported: false,
          },
        },
      },
    },
  }),
  tree: defineCommand({
    namespace: "fs",
    name: "tree",
    program: "tree",
    flags: {
      a: { cli: "-a", kind: "boolean" },
      d: { cli: "-d", kind: "boolean" },
      f: { cli: "-f", kind: "boolean" },
      json: { cli: "-J", kind: "boolean" },
      level: { cli: "-L", kind: "number" },
      pattern: { cli: "-P", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  stat: defineCommand({
    namespace: "fs",
    name: "stat",
    program: "stat",
    flags: {
      format: { cli: "-f", kind: "string" },
      follow: { cli: "-L", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    variants: {
      linux: {
        flags: {
          format: { cli: "--format", kind: "string" },
        },
      },
    },
  }),
  chmod: defineCommand({
    namespace: "fs",
    name: "chmod",
    program: "chmod",
    flags: {
      recursive: { cli: "-R", kind: "boolean" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [
      {
        name: "mode",
      },
      {
        name: "paths",
        variadic: true,
      },
    ],
  }),
  ln: defineCommand({
    namespace: "fs",
    name: "ln",
    program: "ln",
    flags: {
      symbolic: { cli: "-s", kind: "boolean" },
      force: { cli: "-f", kind: "boolean" },
      noDereference: { cli: "-n", kind: "boolean" },
      verbose: { cli: "-v", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  realpath: defineCommand({
    namespace: "fs",
    name: "realpath",
    program: "realpath",
    flags: {
      quiet: { cli: "-q", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  mktemp: defineCommand({
    namespace: "fs",
    name: "mktemp",
    program: "mktemp",
    flags: {
      directory: { cli: "-d", kind: "boolean" },
      quiet: { cli: "-q", kind: "boolean" },
    },
    positionals: [
      {
        name: "template",
        optional: true,
      },
    ],
  }),
  du: defineCommand({
    namespace: "fs",
    name: "du",
    program: "du",
    flags: {
      humanReadable: { cli: "-h", kind: "boolean" },
      kilobytes: { cli: "-k", kind: "boolean" },
      summary: { cli: "-s", kind: "boolean" },
      depth: { cli: "-d", kind: "number" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  df: defineCommand({
    namespace: "fs",
    name: "df",
    program: "df",
    flags: {
      humanReadable: { cli: "-h", kind: "boolean" },
      kilobytes: { cli: "-k", kind: "boolean" },
      portable: { cli: "-P", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
};
