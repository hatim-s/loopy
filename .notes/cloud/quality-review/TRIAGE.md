# Quality review triage

Six independent source reviews covered 6ffecdf...9d30ca9. Sol generally found the new boundaries coherent; Opus identified more navigation and duplication costs. Neither production-source pair established a current runtime correctness blocker. Both tooling reviewers found the default queue test's historical source freeze to be a concrete check-maintenance defect. Report severities are retained as written; root decisions below distinguish that defect from runtime failures.

## Implement now

1. Persistence: remove the unused result-blob dependency from artifact export; narrow export reconciliation so ordinary admission does not enumerate attempt history; centralize bridge identity/resource derivation without changing hashes. Simplify misleading admission naming/repeated tails only while preserving same-session first-start obligations and lost-ack behavior. Keep schemas typed and both adapters covered.
2. Service: eliminate the old local forwarding facade through composition or a thin subclass, retain portable service ownership, encode definition absence as null and translate once at the service boundary. Preserve corruption as a distinct error. Make scheduler handling explicit. Record the intentional local direct-call async signature change and update callers rather than adding compatibility forwarding.
3. Queries: remove runCounts now that no production caller uses it. Replace test oracles with independently derived expected state or query-page folds, without weakening grouped-count equivalence coverage.
4. Projection: make field completeness compiler-checked and share input presentation derivation. Preserve exact serialization, row budgets, source ownership and generation fences.
5. Test upkeep: remove historical hash coupling from the default queue test, preserve its behavioral assertions, and clean successful disposable state. Consolidate the three closely matching PROBES workerd harnesses without building a generic testing framework.
6. Documentation: update operator-facing receipt storage/configuration and repository ownership. State retained-data reasons and exit conditions for compatibility paths. Document findings honestly, including what remains out of scope.

## Preserve or defer

- Keep historical evidence and its hashes. Do not delete raw captures, old proof programs or persisted receipt decoding to reduce line counts. The existing accepted datasets are real consumers. Manual proof layout and configurable workload plans are later tooling work, not a reason to discard reproducibility.
- Keep both isolated playground profiles and their ports/state identities. Renaming the running-state profile or deleting filesystem mode would add migration risk unrelated to these fixes.
- Keep checks before and after asynchronous R2 verification. The first preserves rejection semantics; the transactional second fences changes during I/O. Shared pure decisions may be worthwhile later, but deleting a boundary is not an acceptable cleanup.
- Do not remove local child descriptor validation or death/reread checks merely because they appear twice. Their process-boundary role needs separate proof before any simplification.
- Do not move retry/suspension policy into the reducer or redesign rate-admission races in this pass. Shared host policy already fixes the divergence; the proposed moves expand semantic scope.
- Keep the useful negative-control/platform proof and invariant/performance call-count assertions. Do not delete tests based on source-to-test line ratios.
- Do not abstract two different finite-model explorers or provider fakes solely for visual similarity.
- Authority-model cross-adapter equivalence, closed monitor rejection handling, and result-size consistency need targeted follow-up inspection. Avoid silently changing their semantics as part of naming cleanup. Root will assign a narrow additional task if source/reproduction supports a safe correction.

## Work and environment

Six Sol implementation lanes have disjoint primary ownership; cross-owner edits require coordination. No main edits, merges or pushes during this pass. Root will run full checks and fresh independent reviews after integration. The architecture stack was stopped through its identity-checked command before edits; state/volumes remain. Personal listener PIDs 90523 and 41194 stayed unchanged. Exact stop receipt is stack-stop.json.
