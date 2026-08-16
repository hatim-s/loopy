# Provider capability matrix

This matrix describes the registered local adapters. A degraded cell is an
explicit boundary, not an implied emulation. Missing optional CLIs remain
registered so workflow configuration can be inspected, but `doctor` reports
them unavailable and never invents a version.

| Adapter | Structured events | Resume / fork | Model | Tool policy | Workspace / network | Usage | Nested agents | Historical import |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | supported | supported / degraded (resume only) | supported | degraded | workspace policy supported / network degraded | supported | supported when emitted | versioned JSONL |
| Claude Code | supported | supported / degraded (resume only) | supported | supported | degraded; OS/runtime isolation remains separate | supported | supported when forwarded | versioned stream JSON |
| OpenCode | supported | supported / supported | supported | degraded | degraded; ACP and policy emulation are out of scope | supported | supported when emitted | export v1 and run JSON |
| Pi | supported | supported / degraded | supported | supported | degraded; native sandbox is not assumed | supported | degraded | session v3 |

The Phase 2 live probe on 2026-08-17 was read-only: Codex reported
`0.146.0`, Pi reported `0.80.6`, and Claude Code/OpenCode were absent. No
provider task was executed and no API token was spent. Re-run `loopy doctor
--json` to refresh installation state on another machine.

Execution is argv-only (`shell: false`), with an explicit working directory
and an environment allowlist. Provider events are normalized to a shared
session/provenance/usage shape; hidden reasoning is omitted, unknown records
remain diagnostics, and cancellation terminates the child process with a
graceful-then-forced escalation.

The registered adapters are exercised by a deterministic local CLI-shim E2E in
`packages/testing/tests/registered-provider-e2e.test.ts`. That test runs the
same two-agent workflow through all four adapters and compares the resulting
canonical event sequence. It proves adapter/runtime behavior only; it is not
live vendor compatibility evidence.
