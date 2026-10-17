import { git as runtime } from "../../shell/git.js";
import { defineCommand } from "./command.js";

export const git = {
  status: defineCommand(runtime.status.descriptor, {
    branch: "json",
    upstream: "json",
    ahead: "number",
    behind: "number",
    staged: "json[]",
    unstaged: "json[]",
    untracked: "string[]",
    conflicts: "json[]",
    stashes: "number",
  }),
  diff: defineCommand(runtime.diff.descriptor),
  diffNames: defineCommand(runtime.diffNames.descriptor),
  log: defineCommand(runtime.log.descriptor),
  revParse: defineCommand(runtime.revParse.descriptor),
  lsFiles: defineCommand(runtime.lsFiles.descriptor),
  show: defineCommand(runtime.show.descriptor),
  add: defineCommand(runtime.add.descriptor),
  commit: defineCommand(runtime.commit.descriptor),
  push: defineCommand(runtime.push.descriptor),
  pull: defineCommand(runtime.pull.descriptor),
  fetch: defineCommand(runtime.fetch.descriptor),
  checkout: defineCommand(runtime.checkout.descriptor),
  switch: defineCommand(runtime.switch.descriptor),
  branch: defineCommand(runtime.branch.descriptor),
  remote: defineCommand(runtime.remote.descriptor),
  tag: defineCommand(runtime.tag.descriptor),
  worktree: {
    add: defineCommand(runtime.worktree.add.descriptor),
    list: defineCommand(runtime.worktree.list.descriptor),
    remove: defineCommand(runtime.worktree.remove.descriptor),
  },
  stash: {
    push: defineCommand(runtime.stash.push.descriptor),
    pop: defineCommand(runtime.stash.pop.descriptor),
    list: defineCommand(runtime.stash.list.descriptor),
  },
};
