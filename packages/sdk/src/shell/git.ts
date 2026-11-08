import { namespace } from "./builtin";
import { change } from "./git/change";
import { inspect } from "./git/inspect";
import { stash } from "./git/stash";
import { worktree } from "./git/worktree";

export const git = namespace("git", {
  ...inspect,
  ...change,
  worktree,
  stash,
});
