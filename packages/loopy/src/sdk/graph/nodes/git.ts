import { git as runtime } from "../../shell/git.js";
import { defineCommand } from "./command.js";

export const git = {
  status: defineCommand(
    { ...runtime.status.descriptor, parse: "./parsers/git-status.ts" },
    {
      kind: "record",
      fields: {
        branch: "json",
        upstream: "json",
        ahead: "number",
        behind: "number",
        staged: "json[]",
        unstaged: "json[]",
        untracked: "string[]",
        conflicts: "json[]",
        stashes: "number",
      },
    },
  ),
  diff: defineCommand(
    { ...runtime.diff.descriptor, parse: "./parsers/git-diff.ts" },
    { kind: "value", type: "json[]" },
  ),
  diffNames: defineCommand(
    { ...runtime.diffNames.descriptor, parse: "./parsers/git-diff-names.ts" },
    { kind: "value", type: "json[]" },
  ),
  log: defineCommand(
    { ...runtime.log.descriptor, parse: "./parsers/git-log.ts" },
    { kind: "value", type: "json[]" },
  ),
  revParse: defineCommand(
    { ...runtime.revParse.descriptor, parse: "./parsers/git-rev-parse.ts" },
    { kind: "value", type: "string" },
  ),
  lsFiles: defineCommand(
    { ...runtime.lsFiles.descriptor, parse: "./parsers/git-ls-files.ts" },
    { kind: "value", type: "string[]" },
  ),
  show: defineCommand(runtime.show.descriptor),
  add: defineCommand(runtime.add.descriptor),
  commit: defineCommand(runtime.commit.descriptor),
  push: defineCommand(runtime.push.descriptor),
  pull: defineCommand(runtime.pull.descriptor),
  fetch: defineCommand(runtime.fetch.descriptor),
  checkout: defineCommand(runtime.checkout.descriptor),
  switch: defineCommand(runtime.switch.descriptor),
  branch: defineCommand(
    { ...runtime.branch.descriptor, parse: "./parsers/git-branch.ts" },
    { kind: "value", type: "json[]" },
  ),
  remote: defineCommand(
    { ...runtime.remote.descriptor, parse: "./parsers/git-remote.ts" },
    { kind: "value", type: "json[]" },
  ),
  tag: defineCommand(
    { ...runtime.tag.descriptor, parse: "./parsers/git-tag.ts" },
    { kind: "value", type: "json[]" },
  ),
  worktree: {
    add: defineCommand(runtime.worktree.add.descriptor),
    list: defineCommand(
      { ...runtime.worktree.list.descriptor, parse: "./parsers/git-worktree-list.ts" },
      { kind: "value", type: "json[]" },
    ),
    remove: defineCommand(runtime.worktree.remove.descriptor),
  },
  stash: {
    push: defineCommand(runtime.stash.push.descriptor),
    pop: defineCommand(runtime.stash.pop.descriptor),
    list: defineCommand(
      { ...runtime.stash.list.descriptor, parse: "./parsers/git-stash-list.ts" },
      { kind: "value", type: "json[]" },
    ),
  },
};
