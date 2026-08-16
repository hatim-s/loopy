# `@loopy/runtime`

This package currently contains the Phase 0 graph-validation/compiler front-end. `validateWorkflow` accepts unknown input so malformed workflows can receive machine-readable diagnostics with JSON Pointer paths; `prepareExecutionPlan` also accepts the canonical `WorkflowDefinition` from `@loopy/contracts` and returns a normalized graph. It is intentionally only a preparation seam: it does not schedule nodes, launch providers, or execute policies.

Phase 1 adds a headless scheduler while keeping persistence and providers behind
ports. `RuntimeStore.commit` receives transactional intent commands, so the
SQLite adapter can atomically project state and append events without leaking
SQLite types into the scheduler. `ProviderExecutor` and `VerificationExecutor`
are similarly side-effect boundaries; this package never invokes a CLI,
mutates a workspace, or schedules a process.

## Contracts integration

Public `WorkflowDefinition`, `WorkflowNode`, and `WorkflowEdge` types are re-exported from `@loopy/contracts`; the validator keeps a raw-record boundary only for diagnostics and compatibility with malformed/legacy fixtures. Canonical route labels use the contract's `label` field. No scheduler/provider code belongs in this Phase 0 package.

Diagnostic paths use JSON Pointer (`/nodes/2/id`, `/edges/0/target`) and also expose `pathSegments` for callers that need typed path traversal.
