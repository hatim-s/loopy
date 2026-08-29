# Repository maintenance loops

These workflows use Codex in an isolated Git worktree. They leave existing checkouts alone and
open pull requests for dependency changes instead of merging them.

The Codex subprocess uses `danger-full-access` because macOS blocks GitHub CLI access to the
Keychain inside its workspace sandbox. The disposable Git worktree still keeps repository changes
separate from active checkouts.

- `pr-rebase.json` checks non-draft pull requests daily and rebases only branches that can be
  updated safely. It uses `--force-with-lease` and skips conflicts and fork-owned branches.
- `critical-cve-updates.json` scans weekly for critical production dependency advisories and opens
  a focused patch pull request only when a fixed version exists.
- `dependency-maintenance.json` updates direct patch and minor releases weekly, runs repository
  checks, and opens one maintenance pull request.

Import a workflow into a project and create a live schedule:

```sh
loopy workflow import examples/repository-maintenance/pr-rebase.json --project /path/to/project
loopy schedule create --id repository-pr-rebase --workflow a1000000-0000-4000-8000-000000000001 \
  --cron '0 9 * * *' --timezone Asia/Kolkata --live --project /path/to/project
loopy schedule install repository-pr-rebase --all --project /path/to/project
```

Install one schedule per project with `--all`. That launch agent ticks every registered schedule in
the project and avoids several one-minute workers competing for the same local database lock.

Use `--input '{"dryRun":true}'` with `schedule fire` to inspect a repository without pushing or
creating pull requests.
