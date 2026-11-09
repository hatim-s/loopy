import { builtin, PATHS } from "../builtin";
import { parseWorktreeList } from "../parse/git";

export const worktree = {
  add: builtin({
    program: "git",
    path: ["worktree", "add"],
    flags: {
      detach: { cli: "--detach", kind: "boolean" },
      force: { cli: "--force", kind: "boolean" },
      b: { cli: "-b", kind: "string" },
    },
    positionals: PATHS,
  }),
  list: builtin(
    {
      preset: { flags: { porcelain: true, z: false } },
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
    program: "git",
    path: ["worktree", "remove"],
    flags: {
      force: { cli: "--force", kind: "boolean" },
    },
    positionals: PATHS,
  }),
};
