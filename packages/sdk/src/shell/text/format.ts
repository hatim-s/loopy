import { builtin, PATHS } from "../builtin";
import { parseJq, parseSha256, parseWc } from "../parse/text";

export const format = {
  wc: builtin(
    {
      exclude: ["lines", "words", "bytes", "characters"],
      program: "wc",
      flags: {
        lines: { cli: "-l", kind: "boolean" },
        words: { cli: "-w", kind: "boolean" },
        bytes: { cli: "-c", kind: "boolean" },
        characters: { cli: "-m", kind: "boolean" },
      },
      positionals: PATHS,
    },
    { parse: parseWc, out: { kind: "value", type: "json[]" } },
  ),
  tr: builtin({
    program: "tr",
    flags: {
      delete: { cli: "-d", kind: "boolean" },
      squeeze: { cli: "-s", kind: "boolean" },
      complement: { cli: "-c", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  diff: builtin({
    program: "diff",
    flags: {
      unified: { cli: "-u", kind: "boolean" },
      recursive: { cli: "-r", kind: "boolean" },
      brief: { cli: "-q", kind: "boolean" },
      ignoreSpace: { cli: "-w", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  jq: builtin(
    {
      exclude: ["rawOutput", "rawOutput0"],
      preset: { flags: { compactOutput: true } },
      program: "jq",
      flags: {
        rawOutput0: { cli: "--raw-output0", kind: "boolean" },
        rawOutput: { cli: "-r", kind: "boolean" },
        compactOutput: { cli: "-c", kind: "boolean" },
        slurp: { cli: "-s", kind: "boolean" },
        rawInput: { cli: "-R", kind: "boolean" },
        arg: { cli: "--arg", kind: "string", pairs: true },
        argjson: { cli: "--argjson", kind: "string", pairs: true },
        nullInput: { cli: "-n", kind: "boolean" },
        exitStatus: { cli: "-e", kind: "boolean" },
      },
      positionals: PATHS,
    },
    { parse: parseJq, out: { kind: "value", type: "json" } },
  ),
  yq: builtin({
    program: "yq",
    flags: {
      rawOutput: { cli: "-r", kind: "boolean" },
      compactOutput: { cli: "-c", kind: "boolean" },
      exitStatus: { cli: "-e", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  base64: builtin({
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
  }),
  sha256sum: builtin(
    {
      exclude: ["check"],
      program: "sha256sum",
      flags: {
        check: { cli: "-c", kind: "boolean" },
        binary: { cli: "-b", kind: "boolean" },
      },
      positionals: PATHS,
      variants: {
        darwin: {
          program: "shasum",
          path: ["-a", "256"],
        },
      },
    },
    { parse: parseSha256, out: { kind: "value", type: "json[]" } },
  ),
};
