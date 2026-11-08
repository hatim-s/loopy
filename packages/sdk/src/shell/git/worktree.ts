import { builtin } from "../../graph/nodes/command";
import { parseWorktreeList } from "../parse/git";

export const worktree = {
  add: builtin({
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
  list: builtin(
    {
      preset: { flags: { porcelain: true, z: false } },
      namespace: "git",
      name: "worktree.list",
      program: "git",
      path: ["worktree", "list"],
      flags: {
        porcelain: { cli: "--porcelain", kind: "boolean" },
        z: { cli: "-z", kind: "boolean" },
      },
    },
    { parse: parseWorktreeList, out: { kind: "value", type: "json[]" } },
  ),
  remove: builtin({
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
