# Deterministic extraction

Phase 3 extraction is an offline pipeline:

1. A canonical imported session is validated and segmented into causality,
   goal, tool, failure/recovery, verification, feature, variable, and evidence
   records.
2. `extractImportedSession` builds a provider-neutral prompt input and runs the
   strict versioned proposal parser/compiler with a finite repair bound.
3. The returned proposal and `audit` can be persisted in an extraction job,
   reviewed, and approved exactly once into workflow version 1.

The default agent is deterministic and fake. It does not call Codex, Claude,
OpenCode, Pi, or a network service. Provider execution happens only after a
human approval and is controlled by the existing runtime/provider executor.

Every node, inferred input, verifier requirement, and policy reference is
anchored to proposal evidence whose event IDs are present in the imported
canonical trace. Unknown event IDs are rejected and repair attempts stop at
`maxAttempts` (default: 3).

For the optional installed-provider check, use the CLI's explicit
`validate-provider --opt-in` command. It is read-only and probes installation
metadata only; it never starts a provider run.
