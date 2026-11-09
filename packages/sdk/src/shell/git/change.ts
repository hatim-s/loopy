import { builtin, PATHS } from "../builtin";
import { parseBranch, parseRemote, parseTag } from "../parse/git";

export const change = {
  add: builtin({
    program: "git",
    path: ["add"],
    flags: {
      all: { cli: "--all", kind: "boolean" },
      patch: { cli: "--patch", kind: "boolean" },
      force: { cli: "--force", kind: "boolean" },
      update: { cli: "--update", kind: "boolean" },
    },
    positionals: PATHS,
    positionalSeparator: true,
  }),
  commit: builtin({
    program: "git",
    path: ["commit"],
    flags: {
      message: { cli: "-m", kind: "string" },
      all: { cli: "--all", kind: "boolean" },
      amend: { cli: "--amend", kind: "boolean" },
      noEdit: { cli: "--no-edit", kind: "boolean" },
      allowEmpty: { cli: "--allow-empty", kind: "boolean" },
      noVerify: { cli: "--no-verify", kind: "boolean" },
      signoff: { cli: "--signoff", kind: "boolean" },
      file: { cli: "-F", kind: "string" },
    },
    positionals: PATHS,
    positionalSeparator: true,
  }),
  push: builtin({
    program: "git",
    path: ["push"],
    flags: {
      force: { cli: "--force", kind: "boolean" },
      forceWithLease: { cli: "--force-with-lease", kind: "boolean" },
      setUpstream: { cli: "--set-upstream", kind: "boolean" },
      dryRun: { cli: "--dry-run", kind: "boolean" },
      atomic: { cli: "--atomic", kind: "boolean" },
      followTags: { cli: "--follow-tags", kind: "boolean" },
      tags: { cli: "--tags", kind: "boolean" },
      delete: { cli: "--delete", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  pull: builtin({
    program: "git",
    path: ["pull"],
    flags: {
      rebase: { cli: "--rebase", kind: "boolean" },
      ffOnly: { cli: "--ff-only", kind: "boolean" },
      noRebase: { cli: "--no-rebase", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  fetch: builtin({
    program: "git",
    path: ["fetch"],
    flags: {
      all: { cli: "--all", kind: "boolean" },
      prune: { cli: "--prune", kind: "boolean" },
      tags: { cli: "--tags", kind: "boolean" },
      depth: { cli: "--depth", kind: "number" },
    },
    style: "equals",
    positionals: PATHS,
  }),
  checkout: builtin({
    program: "git",
    path: ["checkout"],
    flags: {
      b: { cli: "-b", kind: "string" },
      B: { cli: "-B", kind: "string" },
      force: { cli: "--force", kind: "boolean" },
      detach: { cli: "--detach", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  switch: builtin({
    program: "git",
    path: ["switch"],
    flags: {
      create: { cli: "-c", kind: "string" },
      forceCreate: { cli: "-C", kind: "string" },
      detach: { cli: "--detach", kind: "boolean" },
    },
    positionals: PATHS,
  }),
  branch: builtin(
    {
      exclude: ["showCurrent", "delete", "force"],
      preset: {
        flags: {
          format:
            "%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname)%00%(upstream:track)",
        },
      },
      program: "git",
      path: ["branch"],
      flags: {
        all: { cli: "--all", kind: "boolean" },
        delete: { cli: "--delete", kind: "boolean" },
        force: { cli: "--force", kind: "boolean" },
        remote: { cli: "--remotes", kind: "boolean" },
        format: { cli: "--format", kind: "string" },
        showCurrent: { cli: "--show-current", kind: "boolean" },
      },
      style: "equals",
      positionals: PATHS,
    },
    { parse: parseBranch, out: { kind: "value", type: "json[]" } },
  ),
  remote: builtin(
    {
      preset: { flags: { verbose: true } },
      program: "git",
      path: ["remote"],
      flags: {
        verbose: { cli: "-v", kind: "boolean" },
      },
      positionals: PATHS,
    },
    { parse: parseRemote, out: { kind: "value", type: "json[]" } },
  ),
  tag: builtin(
    {
      exclude: ["delete", "annotate", "message"],
      preset: { flags: { format: "%(refname:short)%00%(objectname)%00%(taggerdate:iso-strict)" } },
      program: "git",
      path: ["tag"],
      flags: {
        list: { cli: "--list", kind: "boolean" },
        delete: { cli: "--delete", kind: "boolean" },
        annotate: { cli: "--annotate", kind: "boolean" },
        message: { cli: "-m", kind: "string" },
        format: { cli: "--format", kind: "string" },
      },
      positionals: PATHS,
    },
    { parse: parseTag, out: { kind: "value", type: "json[]" } },
  ),
};
