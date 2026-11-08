# @loopy/runtime

Private implementation package for hosts, stores, executors, the portable service and local adapters. See [AGENTS.md](../../AGENTS.md) for layer rules and ownership.

## Retained data

Local homes created before `meta.schema_version` became the only schema marker record their version in `PRAGMA user_version`. `store/sqlite/schema/legacy.ts` upgrades schema 13 and 14 homes to schema 15 without dropping records or changing the epoch, adds the schedule overview index to schema 15 homes that predate it, and then resets `user_version` to 0. The frozen schema 13 and 14 fixtures under `packages/loopy/_tests_/fixtures/sqlite/` keep that path tested.

Remove `upgradeLegacyHome` and its fixtures once no supported local home still has a non-zero `user_version`. Opening such a home after removal must keep rejecting it without resetting it.
