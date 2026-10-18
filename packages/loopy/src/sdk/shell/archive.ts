import { RAW_COMMAND_OUTPUT } from "../../core/index.js";
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
    key: "archive.tar",
    out: RAW_COMMAND_OUTPUT,
    operands: {
      kind: "positional",
      parts: [{ name: "paths", optional: true, variadic: true }],
      separator: false,
    },
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
    key: "archive.gzip",
    out: RAW_COMMAND_OUTPUT,
    operands: {
      kind: "positional",
      parts: [{ name: "paths", optional: true, variadic: true }],
      separator: false,
    },
  },
  zip: {
    program: "zip",
    flags: {
      recursive: { cli: "-r", kind: "boolean" },
      quiet: { cli: "-q", kind: "boolean" },
      update: { cli: "-u", kind: "boolean" },
      exclude: { cli: "-x", kind: "string", position: "after" },
    },
    key: "archive.zip",
    out: RAW_COMMAND_OUTPUT,
    operands: {
      kind: "positional",
      parts: [{ name: "paths", optional: true, variadic: true }],
      separator: false,
    },
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
    key: "archive.unzip",
    out: RAW_COMMAND_OUTPUT,
    operands: {
      kind: "positional",
      parts: [{ name: "paths", optional: true, variadic: true }],
      separator: false,
    },
  },
} as const satisfies Record<string, CommandDescriptor>;

export const archive = defineCommands(archiveDescriptors);
