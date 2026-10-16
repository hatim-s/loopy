import { defineCommand } from "../../define-command.js";

export const worktree = {
  add: defineCommand({
    namespace: "git",
    name: "worktree.add",
    program: "git",
    path: ["worktree", "add"],
    flags: {
      detach: { cli: "--detach", kind: "boolean" },
      force: { cli: "--force", kind: "boolean" },
      b: { cli: "-b", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  list: defineCommand({
    namespace: "git",
    name: "worktree.list",
    program: "git",
    path: ["worktree", "list"],
    flags: {
      porcelain: { cli: "--porcelain", kind: "boolean" },
      z: { cli: "-z", kind: "boolean" },
    },
  }),
  remove: defineCommand({
    namespace: "git",
    name: "worktree.remove",
    program: "git",
    path: ["worktree", "remove"],
    flags: {
      force: { cli: "--force", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
};
