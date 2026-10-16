import { defineCommand } from "../../define-command.js";
import type { RenderInput } from "../../render-argv.js";
import { parseGrep, parseGrepCount, parseUniqCount } from "../parse/text.js";

const GREP_FLAGS = {
  H: { cli: "-H", kind: "boolean" },
  h: { cli: "-h", kind: "boolean" },
  L: { cli: "-L", kind: "boolean" },
  n: { cli: "-n", kind: "boolean" },
  r: { cli: "-r", kind: "boolean" },
  i: { cli: "-i", kind: "boolean" },
  v: { cli: "-v", kind: "boolean" },
  l: { cli: "-l", kind: "boolean" },
  c: { cli: "-c", kind: "boolean" },
  E: { cli: "-E", kind: "boolean" },
  F: { cli: "-F", kind: "boolean" },
  e: { cli: "-e", kind: "string" },
  q: { cli: "-q", kind: "boolean" },
  w: { cli: "-w", kind: "boolean" },
  o: { cli: "-o", kind: "boolean" },
  A: { cli: "-A", kind: "number" },
  B: { cli: "-B", kind: "number" },
  C: { cli: "-C", kind: "number" },
} as const;

function grepInput(input: RenderInput): RenderInput {
  const flags = { ...input.flags };
  const paths = (input.args?.length ?? 0) - (input.flags?.e ? 0 : 1);

  if (paths > 1) {
    flags.H = true;
  }

  return { ...input, flags };
}

export const filter = {
  grep: defineCommand({
    parse: parseGrep,
    okExitCodes: [0, 1],
    preset: { flags: { n: true } },
    exclude: ["c", "l", "L", "o", "q", "H", "h", "A", "B", "C"],
    prepare: grepInput,
    namespace: "text",
    name: "grep",
    program: "grep",
    flags: GREP_FLAGS,
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  grepCount: defineCommand({
    namespace: "text",
    name: "grepCount",
    program: "grep",
    parse: parseGrepCount,
    okExitCodes: [0, 1],
    preset: { flags: { c: true, h: true } },
    exclude: ["n", "l", "L", "o", "q", "H", "r", "A", "B", "C"],
    flags: GREP_FLAGS,
    positionals: [{ name: "pattern" }, { name: "path", optional: true }],
    positionalSeparator: true,
  }),
  sed: defineCommand({
    namespace: "text",
    name: "sed",
    program: "sed",
    flags: {
      n: { cli: "-n", kind: "boolean" },
      E: { cli: "-E", kind: "boolean" },
      expression: {
        cli: "-e",
        kind: "string",
        repeatable: true,
      },
      file: { cli: "-f", kind: "string" },
      inPlace: { cli: "-i", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    variants: {
      linux: {
        flags: {
          inPlace: {
            cli: "-i",
            kind: "string",
            style: "attached",
          },
        },
      },
    },
  }),
  awk: defineCommand({
    namespace: "text",
    name: "awk",
    program: "awk",
    flags: {
      fieldSeparator: { cli: "-F", kind: "string" },
      assign: {
        cli: "-v",
        kind: "string",
        repeatable: true,
      },
      file: { cli: "-f", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  cut: defineCommand({
    namespace: "text",
    name: "cut",
    program: "cut",
    flags: {
      fields: { cli: "-f", kind: "string" },
      delimiter: { cli: "-d", kind: "string" },
      characters: { cli: "-c", kind: "string" },
      bytes: { cli: "-b", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  sort: defineCommand({
    namespace: "text",
    name: "sort",
    program: "sort",
    flags: {
      numeric: { cli: "-n", kind: "boolean" },
      reverse: { cli: "-r", kind: "boolean" },
      unique: { cli: "-u", kind: "boolean" },
      key: { cli: "-k", kind: "string" },
      separator: { cli: "-t", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  uniq: defineCommand({
    namespace: "text",
    name: "uniq",
    program: "uniq",
    flags: {
      count: { cli: "-c", kind: "boolean" },
      repeated: { cli: "-d", kind: "boolean" },
      unique: { cli: "-u", kind: "boolean" },
      ignoreCase: { cli: "-i", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  uniqCount: defineCommand({
    namespace: "text",
    name: "uniqCount",
    parse: parseUniqCount,
    preset: { flags: { count: true } },
    program: "uniq",
    flags: {
      count: { cli: "-c", kind: "boolean" },
      repeated: { cli: "-d", kind: "boolean" },
      unique: { cli: "-u", kind: "boolean" },
      ignoreCase: { cli: "-i", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  head: defineCommand({
    namespace: "text",
    name: "head",
    program: "head",
    flags: {
      lines: { cli: "-n", kind: "number" },
      bytes: { cli: "-c", kind: "number" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  tail: defineCommand({
    namespace: "text",
    name: "tail",
    program: "tail",
    flags: {
      lines: { cli: "-n", kind: "number" },
      bytes: { cli: "-c", kind: "number" },
      follow: { cli: "-f", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
};
