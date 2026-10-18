import type { CommandDescriptor } from "../define-command.js";
import { defineCommands } from "../graph/nodes/command.js";

export const archiveDescriptors = {
  tar: {
    program: "tar",
    flags: {
      create: { cli: "-c", kind: "boolean" },
      extract: { cli: "-x", kind: "boolean" },
      list: { cli: "-t", kind: "boolean" },
      gzip: { cli: "-z", kind: "boolean" },
      bzip2: { cli: "-j", kind: "boolean" },
      verbose: { cli: "-v", kind: "boolean" },
      file: { cli: "-f", kind: "string" },
      directory: { cli: "-C", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    key: "archive.tar",
  },
  gzip: {
    program: "gzip",
    flags: {
      decompress: { cli: "-d", kind: "boolean" },
      stdout: { cli: "-c", kind: "boolean" },
      keep: { cli: "-k", kind: "boolean" },
      force: { cli: "-f", kind: "boolean" },
      recursive: { cli: "-r", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    key: "archive.gzip",
  },
  zip: {
    program: "zip",
    flags: {
      recursive: { cli: "-r", kind: "boolean" },
      quiet: { cli: "-q", kind: "boolean" },
      update: { cli: "-u", kind: "boolean" },
      exclude: { cli: "-x", kind: "string", position: "after" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    key: "archive.zip",
  },
  unzip: {
    program: "unzip",
    flags: {
      list: { cli: "-l", kind: "boolean" },
      overwrite: { cli: "-o", kind: "boolean" },
      neverOverwrite: { cli: "-n", kind: "boolean" },
      quiet: { cli: "-q", kind: "boolean" },
      directory: { cli: "-d", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    key: "archive.unzip",
  },
} as const satisfies Record<string, CommandDescriptor>;

export const archive = defineCommands(archiveDescriptors);
