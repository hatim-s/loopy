import { descriptorCommand } from "../../descriptor.js";
import { parseStashList } from "../parse/git.js";

export const stash = {
  push: descriptorCommand({
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
  pop: descriptorCommand({
    namespace: "git",
    name: "stash.pop",
    program: "git",
    path: ["stash", "pop"],
    flags: {
      index: { cli: "--index", kind: "boolean" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
  list: descriptorCommand({
    parse: parseStashList,
    preset: { flags: { format: "%gd%x00%H%x00%gs" } },
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
