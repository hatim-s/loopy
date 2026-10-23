# Implementation ownership

Fable round 1 accepted with the corrections in proposal.md. Task prompts carry exact file ownership. Every delegate works on `cloud-integration` in this worktree, uses Standard speed, reads AGENTS and relevant skills, and reports targeted checks, changed semantics and source hashes. No commits, main changes, shared-service restarts, cloud actions, workload launches or further delegation from these lanes. Root coordinates those gates. Tests belong in dedicated `_tests_` paths.

| Lane | Owned production paths | Tests and handoff |
| --- | --- | --- |
| Local child receipts | `packages/loopy/src/executor/` and the narrow worker descriptor composition if required | Existing executor tests and new local receipt contract/subprocess tests; `local-receipts-implementation.md` |
| Sandbox authority | `packages/loopy/src/contract/sandbox-journal*.ts`, `apps/sandbox/src/` except image/worker execution semantics | Existing sandbox tests, authority filesystem/model fixtures; `sandbox-authority-implementation.md` |
| Durable receipt adapter | New `apps/cloud/src/receipts*.ts`, `worker.ts`, `environment.ts`, `wrangler.jsonc`; sandbox HTTP authority adapter by explicit handoff only | New real workerd receipt tests/fixtures; `durable-receipts-implementation.md` |
| Host policy | `packages/loopy/src/host/`, `core/store.ts`, `store/sqlite/nodes.ts`, `store/memory-nodes.ts` | Host/durable-host and model tests; `host-policy-implementation.md` |
| Grouped counts and scope pages | Shared SQLite query files except `nodes.ts`, core `queries.ts`, memory query implementation; no schema changes | Count/scope tests and dedicated workerd fixtures; `read-model-implementation.md` |
| Definition summaries | `service/`, `local/service.ts`, new contract summary module, cloud artifact registry/summary files | Registry/service summary tests; `summaries-implementation.md` |
| Workload profile | `scripts/playground/`, `scripts/daemon-playground/` | Harness-only focused validations; `workload-profile.md` |

Root owns shared `index.ts` exports and integration changes not explicitly transferred. Ask root to resolve cross-lane ownership rather than editing another lane's files. Freeze the sandbox journal contract before the durable adapter implementation; its agent can inspect and plan while waiting. Read-projection and summary lanes agree the batched count signature through root. Host and SQL lanes share no mutation file. Separate workerd tests avoid editing the existing broad cloud-worker fixture concurrently.

Workload fixtures remain unchanged. Root may assign independent reviews, model exploration or measurement as separate tasks after the relevant source boundary is stable. Root handles full repository checks after source convergence so broad check output reflects a coherent implementation.
