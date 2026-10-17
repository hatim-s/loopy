import { git as runtime } from "../../shell/git.js";
import { defineCommand } from "./command.js";

export const git = {
  status: defineCommand(runtime.status.descriptor, {
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
  }),
  diff: defineCommand(runtime.diff.descriptor, { kind: "value", type: "json[]" }),
  diffNames: defineCommand(runtime.diffNames.descriptor, { kind: "value", type: "json[]" }),
  log: defineCommand(runtime.log.descriptor, { kind: "value", type: "json[]" }),
  revParse: defineCommand(runtime.revParse.descriptor, { kind: "value", type: "string" }),
  lsFiles: defineCommand(runtime.lsFiles.descriptor, { kind: "value", type: "string[]" }),
  show: defineCommand(runtime.show.descriptor),
  add: defineCommand(runtime.add.descriptor),
  commit: defineCommand(runtime.commit.descriptor),
  push: defineCommand(runtime.push.descriptor),
  pull: defineCommand(runtime.pull.descriptor),
  fetch: defineCommand(runtime.fetch.descriptor),
  checkout: defineCommand(runtime.checkout.descriptor),
  switch: defineCommand(runtime.switch.descriptor),
  branch: defineCommand(runtime.branch.descriptor, { kind: "value", type: "json[]" }),
  remote: defineCommand(runtime.remote.descriptor, { kind: "value", type: "json[]" }),
  tag: defineCommand(runtime.tag.descriptor, { kind: "value", type: "json[]" }),
  worktree: {
    add: defineCommand(runtime.worktree.add.descriptor),
    list: defineCommand(runtime.worktree.list.descriptor, { kind: "value", type: "json[]" }),
    remove: defineCommand(runtime.worktree.remove.descriptor),
  },
  stash: {
    push: defineCommand(runtime.stash.push.descriptor),
    pop: defineCommand(runtime.stash.pop.descriptor),
    list: defineCommand(runtime.stash.list.descriptor, { kind: "value", type: "json[]" }),
  },
};
