import type { Prepare } from "../../descriptor";
import { builtin, PATHS } from "../builtin";
import { parseGrep, parseGrepCount, parseUniqCount } from "../parse/text";

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
  f: { cli: "-f", kind: "string" },
  q: { cli: "-q", kind: "boolean" },
  w: { cli: "-w", kind: "boolean" },
  o: { cli: "-o", kind: "boolean" },
  A: { cli: "-A", kind: "number" },
  B: { cli: "-B", kind: "number" },
  C: { cli: "-C", kind: "number" },
} as const;

const grepInput: Prepare = (input) => {
  const hasPattern = input.flags?.e !== undefined || input.flags?.f !== undefined;
  const paths = (input.args?.length ?? 0) - (hasPattern ? 0 : 1);

  return paths > 1 ? { ...input, flags: { ...input.flags, H: true } } : input;
};

const UNIQ_FLAGS = {
  count: { cli: "-c", kind: "boolean" },
  repeated: { cli: "-d", kind: "boolean" },
  unique: { cli: "-u", kind: "boolean" },
  ignoreCase: { cli: "-i", kind: "boolean" },
} as const;

export const filter = {
  grep: builtin(
    {
      okExitCodes: [0, 1],
      preset: { flags: { n: true } },
      exclude: ["c", "l", "L", "o", "q", "H", "h", "A", "B", "C"],
      program: "grep",
      flags: GREP_FLAGS,
      positionals: PATHS,
      positionalSeparator: true,
    },
    {
      parse: parseGrep,
      out: { kind: "record", fields: { matches: "json[]", binaryMatches: "string[]" } },
      prepare: grepInput,
    },
  ),
  grepCount: builtin(
    {
      program: "grep",
      okExitCodes: [0, 1],
      preset: { flags: { c: true, h: true } },
      exclude: ["n", "l", "L", "o", "q", "H", "r", "A", "B", "C", "e", "f"],
      flags: GREP_FLAGS,
      positionals: [{ name: "pattern" }, { name: "path", optional: true }],
      positionalSeparator: true,
    },
    { parse: parseGrepCount, out: { kind: "value", type: "number" } },
  ),
  sed: builtin({
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
    positionals: PATHS,
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
  awk: builtin({
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
    positionals: PATHS,
  }),
  cut: builtin({
    program: "cut",
    flags: {
      fields: { cli: "-f", kind: "string" },
      delimiter: { cli: "-d", kind: "string" },
      characters: { cli: "-c", kind: "string" },
      bytes: { cli: "-b", kind: "string" },
    },
    positionals: PATHS,
  }),
  sort: builtin({
    program: "sort",
    flags: {
      numeric: { cli: "-n", kind: "boolean" },
      reverse: { cli: "-r", kind: "boolean" },
      unique: { cli: "-u", kind: "boolean" },
      key: { cli: "-k", kind: "string" },
      separator: { cli: "-t", kind: "string" },
    },
    positionals: PATHS,
  }),
  uniq: builtin({
    program: "uniq",
    flags: UNIQ_FLAGS,
    positionals: PATHS,
  }),
  uniqCount: builtin(
    {
      preset: { flags: { count: true } },
      program: "uniq",
      flags: UNIQ_FLAGS,
      positionals: PATHS,
    },
    { parse: parseUniqCount, out: { kind: "value", type: "json[]" } },
  ),
  head: builtin({
    program: "head",
    flags: {
      lines: { cli: "-n", kind: "number" },
      bytes: { cli: "-c", kind: "number" },
    },
    positionals: PATHS,
  }),
  tail: builtin({
    program: "tail",
    flags: {
      lines: { cli: "-n", kind: "number" },
      bytes: { cli: "-c", kind: "number" },
      follow: { cli: "-f", kind: "boolean" },
    },
    positionals: PATHS,
  }),
};
