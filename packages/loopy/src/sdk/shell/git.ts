import { change } from "./git/change.js";
import { inspect } from "./git/inspect.js";
import { stash } from "./git/stash.js";
import { worktree } from "./git/worktree.js";

export const git = {
  ...inspect,
  ...change,
  worktree,
  stash,
};
