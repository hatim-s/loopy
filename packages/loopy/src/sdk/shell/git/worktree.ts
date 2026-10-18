import { descriptorCommand } from "../../descriptor.js";
import { parseWorktreeList } from "../parse/git.js";

export const worktree = {
  add: descriptorCommand({
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
  list: descriptorCommand({
    parse: parseWorktreeList,
    preset: { flags: { porcelain: true, z: false } },
    namespace: "git",
    name: "worktree.list",
    program: "git",
    path: ["worktree", "list"],
    flags: {
      porcelain: { cli: "--porcelain", kind: "boolean" },
      z: { cli: "-z", kind: "boolean" },
    },
  }),
  remove: descriptorCommand({
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
