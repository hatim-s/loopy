# `@loopy/runtime`

This package currently contains the Phase 0 graph-validation/compiler front-end. `validateWorkflow` accepts unknown input so malformed workflows can receive machine-readable diagnostics with JSON Pointer paths; `prepareExecutionPlan` also accepts the canonical `WorkflowDefinition` from `@loopy/contracts` and returns a normalized graph. It is intentionally only a preparation seam: it does not schedule nodes, launch providers, or execute policies.

Phase 1 adds a headless scheduler while keeping persistence and providers behind
ports. `RuntimeStore.commit` receives transactional intent commands, so the
SQLite adapter can atomically project state and append events without leaking
SQLite types into the scheduler. `ProviderExecutor` and `VerificationExecutor`
are similarly side-effect boundaries; this package never invokes a CLI,
mutates a workspace, or schedules a process.

The `resolve_approval` command carries compare-and-set expectations for the
active run, pending approval, and blocked attempt. A production adapter must
enforce those expectations, plus all state transitions, inside its one
transaction; this is the adapter seam used by the in-memory conformance store.
Run records created by the scheduler include `executionPlanHash`, and the
`run.created`/`run.started` intents copy that value into their event payloads.

## Provider execution seam

`createProviderExecutor` sends the fully merged workflow/node `ProviderPolicy` in
the provider request's additive `policy` field and mirrors it under `metadata.policy`
for adapters compiled against the older request shape. The provider package owns
translation to CLI flags and capability errors; the runtime validates policy values
and fails the attempt when the policy is malformed. Provider runs return an
immediate cancellation handle, while the executor still accepts promise-returning
adapters during the seam transition.

Provider callbacks are persistence-ready `TraceEvent` envelopes, validated against
`TraceEventSchema`, with run/node/attempt/provider/session attribution in the
envelope. A provider execution only succeeds after a canonical
`provider.session_ended` event explicitly reports `succeeded`; missing, failed, or
cancelled terminal evidence never becomes a successful attempt.

## Contracts integration

Public `WorkflowDefinition`, `WorkflowNode`, and `WorkflowEdge` types are re-exported from `@loopy/contracts`; the validator keeps a raw-record boundary only for diagnostics and compatibility with malformed/legacy fixtures. Canonical route labels use the contract's `label` field. No scheduler/provider code belongs in this Phase 0 package.

Diagnostic paths use JSON Pointer (`/nodes/2/id`, `/edges/0/target`) and also expose `pathSegments` for callers that need typed path traversal.
