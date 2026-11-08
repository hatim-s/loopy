import { builtin, PATHS } from "../builtin";
import { parseStashList } from "../parse/git";

export const stash = {
  push: builtin({
    program: "git",
    path: ["stash", "push"],
    flags: {
      includeUntracked: { cli: "--include-untracked", kind: "boolean" },
      all: { cli: "--all", kind: "boolean" },
      message: { cli: "-m", kind: "string" },
    },
    positionals: PATHS,
    positionalSeparator: true,
  }),
  pop: builtin({
    program: "git",
    path: ["stash", "pop"],
    flags: {
      index: { cli: "--index", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  list: builtin(
    {
      preset: { flags: { format: "%gd%x00%H%x00%gs" } },
      program: "git",
      path: ["stash", "list"],
      flags: {
        format: { cli: "--format", kind: "string" },
      },
      style: "equals",
    },
    { parse: parseStashList, out: { kind: "value", type: "json[]" } },
  ),
};
