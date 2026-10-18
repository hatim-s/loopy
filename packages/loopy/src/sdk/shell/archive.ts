import { descriptorCommand } from "../descriptor.js";

export const archive = {
  tar: descriptorCommand({
    namespace: "archive",
    name: "tar",
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
  }),
  gzip: descriptorCommand({
    namespace: "archive",
    name: "gzip",
    program: "gzip",
    flags: {
      decompress: { cli: "-d", kind: "boolean" },
      stdout: { cli: "-c", kind: "boolean" },
      keep: { cli: "-k", kind: "boolean" },
      force: { cli: "-f", kind: "boolean" },
      recursive: { cli: "-r", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  zip: descriptorCommand({
    namespace: "archive",
    name: "zip",
    program: "zip",
    flags: {
      recursive: { cli: "-r", kind: "boolean" },
      quiet: { cli: "-q", kind: "boolean" },
      update: { cli: "-u", kind: "boolean" },
      exclude: { cli: "-x", kind: "string", position: "after" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  unzip: descriptorCommand({
    namespace: "archive",
    name: "unzip",
    program: "unzip",
    flags: {
      list: { cli: "-l", kind: "boolean" },
      overwrite: { cli: "-o", kind: "boolean" },
      neverOverwrite: { cli: "-n", kind: "boolean" },
      quiet: { cli: "-q", kind: "boolean" },
      directory: { cli: "-d", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
};
