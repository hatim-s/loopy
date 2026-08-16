# `@loopy/runtime`

This package currently contains the Phase 0 graph-validation/compiler front-end. `validateWorkflow` accepts a structural `WorkflowDefinition` and returns machine-readable diagnostics with JSON Pointer paths plus a normalized graph. `prepareExecutionPlan` is intentionally only a preparation seam: it does not schedule nodes, launch providers, or execute policies.

## Contracts integration

The contracts package is being developed in parallel. The validator's input types are structural on this branch so the package can test without a workspace dependency. When the contracts branch is integrated, the workspace should make `@loopy/contracts` available and its `WorkflowDefinition` should be assignable to the exported structural type (nodes with `id` and `kind`/`type`, edges with `id`, `source`, and `target`). If contracts chooses a nested-only node shape, keep the existing `config` fallback or update `field()` in `src/validation.ts`; no scheduler/provider code should be added to this package for that integration.

Diagnostic paths use JSON Pointer (`/nodes/2/id`, `/edges/0/target`) and also expose `pathSegments` for callers that need typed path traversal.
