import { type CommandDescriptor, defineCommand } from "../../define-command.js";

export const base64Descriptor = {
  namespace: "text",
  name: "base64",
  program: "base64",
  flags: {
    decode: { cli: "-d", kind: "boolean" },
    input: { cli: "-i", kind: "string" },
  },
  positionals: [],
  variants: {
    linux: {
      flags: { input: { cli: "", kind: "string", style: "positional", position: "after" } },
    },
    darwin: {
      flags: {
        decode: { cli: "-D", kind: "boolean" },
        input: { cli: "-i", kind: "string" },
      },
    },
  },
} as const satisfies CommandDescriptor;

export const format = {
  wc: defineCommand({
    namespace: "text",
    name: "wc",
    program: "wc",
    flags: {
      lines: { cli: "-l", kind: "boolean" },
      words: { cli: "-w", kind: "boolean" },
      bytes: { cli: "-c", kind: "boolean" },
      characters: { cli: "-m", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  tr: defineCommand({
    namespace: "text",
    name: "tr",
    program: "tr",
    flags: {
      delete: { cli: "-d", kind: "boolean" },
      squeeze: { cli: "-s", kind: "boolean" },
      complement: { cli: "-c", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  diff: defineCommand({
    namespace: "text",
    name: "diff",
    program: "diff",
    flags: {
      unified: { cli: "-u", kind: "boolean" },
      recursive: { cli: "-r", kind: "boolean" },
      brief: { cli: "-q", kind: "boolean" },
      ignoreSpace: { cli: "-w", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  jq: defineCommand({
    namespace: "text",
    name: "jq",
    program: "jq",
    flags: {
      rawOutput: { cli: "-r", kind: "boolean" },
      compactOutput: { cli: "-c", kind: "boolean" },
      slurp: { cli: "-s", kind: "boolean" },
      rawInput: { cli: "-R", kind: "boolean" },
      arg: { cli: "--arg", kind: "string", pairs: true },
      argjson: { cli: "--argjson", kind: "string", pairs: true },
      nullInput: { cli: "-n", kind: "boolean" },
      exitStatus: { cli: "-e", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  yq: defineCommand({
    namespace: "text",
    name: "yq",
    program: "yq",
    flags: {
      rawOutput: { cli: "-r", kind: "boolean" },
      compactOutput: { cli: "-c", kind: "boolean" },
      exitStatus: { cli: "-e", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  base64: defineCommand(base64Descriptor),
  sha256sum: defineCommand({
    namespace: "text",
    name: "sha256sum",
    program: "sha256sum",
    flags: {
      check: { cli: "-c", kind: "boolean" },
      binary: { cli: "-b", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    variants: {
      darwin: {
        program: "shasum",
        path: ["-a", "256"],
      },
    },
  }),
};
