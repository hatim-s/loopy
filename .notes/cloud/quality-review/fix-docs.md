# Documentation correction

Completed the assigned documentation lane on `cloud-integration`, starting and ending HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`. Read all six paired quality reviews and `TRIAGE.md`, then checked current code. Applied `unslop`, `typescript-codebase-craft` and its architecture/TypeScript references. Read Planloft writing guidance; the explicit repository Markdown destinations override its storage workflow.

## Changes

- `AGENTS.md` project section now maps portable service ownership, local/durable host policy, cloud/sandbox apps and workload scripts. It names all three gated test roots and records disposable-state, project-marker, home and child-environment isolation rules.
- `apps/cloud/README.md` documents filesystem CLI/default playground versus DO-backed architecture playground composition. It names `SANDBOX_RECEIPTS`, `RECEIPT_RESULTS`, `v2-receipts`, the internal route and all three `RECEIPTS_*` settings without including private values. It explains session fencing, post-lock dependency construction, immutable result verification before pointer publication and export cleanup. A short Mermaid flow shows persistence before Docker work and result bytes before the terminal pointer.
- `apps/sandbox/README.md` replaces the obsolete inline-result description with attempt plans, immutable result files, sessions, guards and released-token records. It describes injected DO composition without claiming a CLI mode flag, retains Docker confinement guidance, and clarifies exact-resource cleanup with confirmed helper removal.
- `CONTRIBUTING.md` replaces removed runtime/step-replay/schema-reset guidance with graph/engine entries, portable service composition, node/attempt identity, no-repeat-started recovery and retained SQLite 13/14 upgrades.
- Compatibility remains for accepted persisted datasets. Exit conditions require verified migration or explicit retirement of affected roots/homes, reconciled attempts/guards and generation-matched summary projections across retained workspaces. Historical evidence and phase 2 approval gates remain intact.
- Removed hardcoded personal checkout paths from both app READMEs. No runtime credentials, private configuration or personal state were read.

Runtime behavior changes: none. These edits describe existing behavior and the coordinated quality-pass isolation rules. No source, config, tests, datasets, services or historical evidence were changed by this lane. Sibling source/test edits were left intact. No cross-owner edit was needed.

## Verification

Static source checks covered package exports and the test command; the architecture import test; local service composition and registry contracts; host activation policy; native/local SQL schema initialization; cloud receipt bindings, configuration, sessions and completion transactions; immutable filesystem/R2 result stores; sandbox startup, admission/export coordination and shutdown; playground authority/profile selection and fresh-root guard.

After sibling edits appeared, reread local service/registry composition, the authority operation contract, export reconciliation, the attempt coordinator, cloud completion and the fresh-root selection guard. The docs refer to owners and public composition boundaries rather than helper names being simplified by other lanes.

Verification commands and results:

- `git rev-parse HEAD` printed the pin above at entry and final verification.
- `git diff --check -- AGENTS.md CONTRIBUTING.md apps/cloud/README.md apps/sandbox/README.md` exited 0 with no output, including final verification.
- `git diff --numstat -- AGENTS.md CONTRIBUTING.md apps/cloud/README.md apps/sandbox/README.md` printed the per-file counts below.
- `python3 -I -` ran a read-only inline validator over the four documents and current source/config. It checked balanced Markdown fences, existing local link targets, absence of em dashes/personal absolute paths, all three gated test roots against `package.json`, receipt binding/configuration names against checked-in source, removal of stale contributor terms and the FS CLI/DO playground composition. It exited 0 and printed `PASS: 4 Markdown documents; fences, links, bindings, test roots, stale guidance and composition checks.`

| File | Added | Deleted |
| --- | ---: | ---: |
| `AGENTS.md` | 24 | 6 |
| `CONTRIBUTING.md` | 13 | 10 |
| `apps/cloud/README.md` | 36 | 4 |
| `apps/sandbox/README.md` | 21 | 7 |
| Total documentation | 94 | 27 |

Production source delta: +0/-0. Tests moved/deleted: none. This new report is separate from the four-document delta.

No code-importing tests, lint/typecheck, full check, Docker, cloud calls, browser, existing-service actions, personal-home/state access or retained-dataset reads were needed for this documentation-only lane. The bounded validation wrote no test state. Root owns integration and full checks; no runtime or deployment acceptance is claimed. No commits or pushes were made. Documentation is stable for integration.
