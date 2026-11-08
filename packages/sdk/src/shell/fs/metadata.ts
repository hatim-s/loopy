import { builtin } from "../builtin";
import {
  parseDf,
  parseDu,
  parseFind,
  parseMktemp,
  parseRealpath,
  parseStat,
  parseTree,
  parseWhich,
  STAT_DARWIN_FORMAT,
  STAT_LINUX_FORMAT,
} from "../parse/fs";
import { currentDirectory } from "./files";

export const metadata = {
  find: builtin(
    {
      preset: { flags: { print0: true } },
      exclude: ["print", "ls", "delete", "printf", "exec", "prune"],
      program: "find",
      flags: {
        name: { cli: "-name", kind: "string" },
        iname: { cli: "-iname", kind: "string" },
        path: { cli: "-path", kind: "string" },
        notName: { cli: "-name", kind: "string", prefix: ["!"] },
        notPath: { cli: "-path", kind: "string", prefix: ["!"] },
        mtime: { cli: "-mtime", kind: "string" },
        size: { cli: "-size", kind: "string" },
        type: { cli: "-type", kind: "string" },
        maxDepth: { cli: "-maxdepth", kind: "number" },
        minDepth: { cli: "-mindepth", kind: "number" },
        print0: { cli: "-print0", kind: "boolean", order: 10 },
        empty: { cli: "-empty", kind: "boolean" },
        ls: { cli: "-ls", kind: "boolean", order: 10 },
        print: { cli: "-print", kind: "boolean", order: 10 },
        prune: { cli: "-prune", kind: "boolean", order: 10 },
        exec: { cli: "-exec", kind: "string", repeatable: true, terminator: ";", order: 10 },
        delete: { cli: "-delete", kind: "boolean", order: 10 },
        printf: { cli: "-printf", kind: "string", order: 10 },
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
    },
    { parse: parseFind, out: { kind: "value", type: "string[]" }, prepare: currentDirectory },
  ),
  tree: builtin(
    {
      preset: { flags: { json: true, noReport: true } },
      exclude: ["f", "indent", "noIndent", "color", "classify"],
      program: "tree",
      flags: {
        a: { cli: "-a", kind: "boolean" },
        d: { cli: "-d", kind: "boolean" },
        f: { cli: "-f", kind: "boolean" },
        noReport: { cli: "--noreport", kind: "boolean" },
        indent: { cli: "-A", kind: "boolean" },
        noIndent: { cli: "-i", kind: "boolean" },
        color: { cli: "-C", kind: "boolean" },
        classify: { cli: "-F", kind: "boolean" },
        json: { cli: "-J", kind: "boolean" },
        level: { cli: "-L", kind: "number" },
        pattern: { cli: "-P", kind: "string" },
      },
      positionals: [{ name: "paths", optional: true, variadic: true }],
    },
    { parse: parseTree, out: { kind: "value", type: "json[]" } },
  ),
  stat: builtin(
    {
      preset: { flags: { format: STAT_DARWIN_FORMAT } },
      program: "stat",
      flags: {
        format: { cli: "-f", kind: "string" },
        follow: { cli: "-L", kind: "boolean" },
      },
      positionals: [{ name: "paths", optional: true, variadic: true }],
      variants: {
        linux: {
          preset: { flags: { format: STAT_LINUX_FORMAT } },
          flags: {
            format: { cli: "-c", kind: "string" },
          },
        },
      },
    },
    { parse: parseStat, out: { kind: "value", type: "json[]" } },
  ),
  chmod: builtin({
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
  ln: builtin({
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
  realpath: builtin(
    {
      parsedPositionals: [{ name: "path" }],
      program: "realpath",
      flags: {
        quiet: { cli: "-q", kind: "boolean" },
      },
      positionals: [{ name: "paths", optional: true, variadic: true }],
    },
    { parse: parseRealpath, out: { kind: "value", type: "string" } },
  ),
  which: builtin(
    {
      program: "which",
      okExitCodes: [0, 1],
      positionals: [{ name: "program" }],
    },
    { parse: parseWhich, out: { kind: "value", type: "json" } },
  ),
  mktemp: builtin(
    {
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
    },
    { parse: parseMktemp, out: { kind: "value", type: "string" } },
  ),
  du: builtin(
    {
      preset: { flags: { kilobytes: true } },
      exclude: ["humanReadable"],
      program: "du",
      flags: {
        humanReadable: { cli: "-h", kind: "boolean" },
        kilobytes: { cli: "-k", kind: "boolean" },
        summary: { cli: "-s", kind: "boolean" },
        depth: { cli: "-d", kind: "number" },
      },
      positionals: [{ name: "paths", optional: true, variadic: true }],
    },
    { parse: parseDu, out: { kind: "value", type: "json[]" } },
  ),
  df: builtin(
    {
      preset: { flags: { kilobytes: true, portable: true } },
      exclude: ["humanReadable"],
      program: "df",
      flags: {
        humanReadable: { cli: "-h", kind: "boolean" },
        kilobytes: { cli: "-k", kind: "boolean" },
        portable: { cli: "-P", kind: "boolean" },
      },
      positionals: [{ name: "paths", optional: true, variadic: true }],
    },
    { parse: parseDf, out: { kind: "value", type: "json[]" } },
  ),
};
