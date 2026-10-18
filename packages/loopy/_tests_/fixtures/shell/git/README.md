# Git parser fixtures

Captured on Darwin on 2026-10-17 with `git version 2.50.1 (Apple Git-155)` from disposable repositories.
The shared machine-format cases use the Darwin captures.
`status-stash.linux.txt` is a separate stash-header fixture.
NUL bytes and final blank worktree record separators are intentional.
Worktree paths retain the temporary capture root.

`status` includes a merge conflict, an index rename with spaces, staged text and binary
changes, an unstaged change, an untracked file, and a branch ahead 1 and behind 1.
`status-detached` comes from a detached worktree. `worktree-list` contains the main,
locked and detached worktrees; `worktree-bare` is a separate bare repository.
The other captures use the wrapper presets, with `--cached` for both diff commands.
`log` has a multiline body, a blank line and an ASCII record-separator byte. It uses
seven NUL-delimited fields per commit and `-z`, since NUL cannot occur in valid Git
commit messages. ASCII record separators can occur in bodies and are not delimiters.
`tag` includes annotated and lightweight tags. `remote` has distinct fetch/push URLs.
`stash-list` was captured after an explicit `git stash push -m 'Fixture stash'`.

`worktree-quoted` adds a tab and a UTF-8 character in a worktree path, a lock
reason with a newline, and a missing worktree with a prunable reason.

`status-paths` preserves literal newline, tab and UTF-8 characters in staged paths.
