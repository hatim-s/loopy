import { defineCommand } from "../../define-command.js";

export const stash = {
  push: defineCommand({
    namespace: "git",
    name: "stash.push",
    program: "git",
    path: ["stash", "push"],
    flags: {
      includeUntracked: { cli: "--include-untracked", kind: "boolean" },
      all: { cli: "--all", kind: "boolean" },
      message: { cli: "-m", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    positionalSeparator: true,
  }),
  pop: defineCommand({
    namespace: "git",
    name: "stash.pop",
    program: "git",
    path: ["stash", "pop"],
    flags: {
      index: { cli: "--index", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  list: defineCommand({
    namespace: "git",
    name: "stash.list",
    program: "git",
    path: ["stash", "list"],
    flags: {
      format: { cli: "--format", kind: "string" },
    },
    style: "equals",
  }),
};
