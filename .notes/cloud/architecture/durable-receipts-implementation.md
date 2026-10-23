---
title: Durable sandbox receipts implementation
status: focused verification complete, root integration pending
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Scope and result

Implemented the local SQLite Durable Object authority, R2 immutable results, direct internal Worker route and typed sandbox HTTP adapter. Work remained on `cloud-integration` in `/Users/hatim.shakir/projects/loopy/cloud-integration`. The proposal and accepted Fable corrections governed this lane. The sandbox lane owns filesystem compatibility and bridge lifecycle; root owns shared exports, launcher integration and workload acceptance.

No main changes, commits, pushes, cloud calls, Docker launches, shared-service changes or reads of existing workload datasets occurred. Fresh workerd persistence and bundles used unique `.loopy/architecture-tests/receipts-*` directories, removed before handoff. Negative-control logs remain in the separate unique directory listed below.

# Integration signatures

`HttpSandboxAuthority` is exported from `apps/sandbox/src/http-authority.ts` and implements the frozen `SandboxAttemptAuthority` contract. All inputs and replies use the schemas exported by the root-owned contract entry. There is no generic cast from HTTP JSON to a reply.

```ts
constructor(options: { url: string; token: string; namespace: string });
status(): Promise<AuthorityOutput<"status">>;
openSession(input: AuthorityInput<"openSession">): Promise<AuthoritySession>;
read(id: string): Promise<AttemptRecord | null>;
admit(input: AuthorityInput<"admit">): Promise<AuthorityOutput<"admit">>;
complete(input: AuthorityInput<"complete">): Promise<AuthorityOutput<"complete">>;
beginExport(input: AuthorityInput<"beginExport">): Promise<AuthorityOutput<"beginExport">>;
endExport(input: AuthorityInput<"endExport">): Promise<void>;
recoverable(input: AuthorityInput<"recoverable">): Promise<AuthorityOutput<"recoverable">>;
resultsFor(workspace: string): ImmutableResults;
```

The constructor takes a loopback HTTP origin with no credentials, path, query or fragment. Requests use a finite 5,000 ms abort deadline and reject redirects. Bind the results factory to its instance when injecting it.

```ts
const authority = new HttpSandboxAuthority({ url, token, namespace });
const resultsFor = (workspace: string) => authority.resultsFor(workspace);
```

`R2ImmutableResults` is exported from `apps/cloud/src/receipts-results.ts`.

```ts
constructor(bucket: R2Bucket, namespace: string, workspace: string);
put(result: SandboxExecutionResult): Promise<ResultRef>;
get(ref: ResultRef): Promise<SandboxExecutionResult>;
```

`SandboxReceipts` is exported from `apps/cloud/src/worker.ts` and `receipts.ts`.

```ts
constructor(ctx: DurableObjectState, env: Environment);
fetch(request: Request): Promise<Response>;
```

The direct route is `POST /internal/sandbox-receipts`. The body is the frozen `authorityCommandSchema` union `{ operation, input }`, covering the eight authority operations and `resultPut`/`resultGet`. Replies are the corresponding operation's output schema. Union operations return `rejected` for stale, missing and conflicting operations. `openSession` and `endExport` throw closed `AuthorityError` values, transported as HTTP 409 with `authorityErrorSchema`. Storage or malformed persisted content becomes HTTP 500 and never absence. Invalid requests become HTTP 400. Internal requests require `Authorization: Bearer <RECEIPTS_TOKEN>` and `X-Loopy-Receipts-Namespace: <RECEIPTS_NAMESPACE>`.

The Worker requires these new bindings/configuration fields when the internal path is used:

- `SANDBOX_RECEIPTS: DurableObjectNamespace`, class `SandboxReceipts`.
- `RECEIPT_RESULTS: R2Bucket`.
- `RECEIPTS_TOKEN: string`, 32 to 256 characters, distinct from every `LOCAL_AUTH` principal token.
- `RECEIPTS_NAMESPACE: string`, 1 to 256 characters matching `^[A-Za-z0-9_-]+$`.
- `RECEIPTS_ROOT: string`, canonical absolute sandbox root without trailing, empty, dot or parent components.

The local stage, loopback HTTP host and absence of browser Origin are checked before internal access. Principal routing is separate. Namespace comes from configuration, and the Worker routes directly to that named receipt object. The object pins namespace/root in SQL, rejecting later changes. The DO recomputes attempt IDs, input/container names and run-volume names from the configured root and complete ordered execution identity. Credentials and roots have no default in Wrangler. The existing Workspace migration is retained; `v2-receipts` appends the new SQLite class. `workers_dev` and preview URLs remain disabled.

# State and byte semantics

Each session CAS, admission, completion and export mutation uses synchronous `transactionSync`, with no await inside transactions. Session history rejects old epochs and reused old nonces. A matching current nonce is idempotent. Admission checks the current session, then existing request hash, then active same-volume export guards. Exactly one created grant is returned. Duplicates retain the first plan, deadline and admitting session. Both started and finished records carry that original session; a current successor can finish recovered work.

Terminal results use blob locations only. SQL decoding rejects inline terminal records. Completion verifies the workspace-bound result bytes before entering the SQL pointer transaction, which rechecks session/hash/state. Matching terminal replay returns the winner. A different hash or size returns request conflict before attempting an unrelated blob read.

R2 keys are `receipts/<encoded namespace>/workspaces/<encoded workspace>/results/<server-computed sha256>`. Result put canonicalizes and hashes bytes on the server. Canonical results over 2 MiB become a small `output_limit` failure. Conditional create preserves existing bytes; collisions verify existing content. Successful fresh puts avoid a redundant readback. Every get verifies size, SHA-256, UTF-8 and result schema. Missing, oversized, malformed or changed objects throw. No blobs or receipts are deleted. A failed SQL publication can leave an orphan blob.

Exports persist an exact helper name before helper creation. Active guards block new same-volume admissions across reconstruction. Different volumes can proceed. A stale session cannot release a guard. The current session may release an older guard after the trusted bridge confirms helper absence. Released tokens remain tombstones, so release is idempotent and a released token cannot obtain a new grant. The DO trusts the bridge's helper-absence observation; it cannot inspect Docker itself.

Recovery uses a tagged cursor and one combined count limit, capped at 200. Two ordered, sargable queries select started IDs and then active export tokens within the same SQL transaction. A page does indexed record lookups for selected rows. It does not scan all terminal receipts or released guards. Cursor traversal is over current recoverable state, not a historical snapshot across mutations.

# Focused verification

Final verification passed 18 tests, 99 assertions, zero failures across five new files. Actual local workerd executes SQLite and R2. Each full reconstruction disposes the runtime and starts another over the same isolated persistence directory. The lost-response scenario forwards to the real authority, drops committed admission and completion replies with HTTP 503, makes the resolving read temporarily unavailable, and reconstructs the runtime before checking the original records and bytes.

Tests cover SQL rollback on constraint failure, twelve concurrent identical admissions yielding one created grant, request/identity conflicts, session CAS and stale writes, exact stale/missing/conflict completion unions, original-session preservation, terminal immutability, persistent export exclusion, successor release, racing admission/export, combined pagination, internal authentication/stage/origin/namespace boundaries, malformed and oversized input, response parsing, R2 isolation/integrity/collisions and publication ordering. Existing tests were neither deleted nor moved.

The real R2 binding was counted by a dedicated fixture around production `SandboxReceipts`. Fresh result put performed one PUT and zero GETs. Completion added one GET before pointer publication. Reading the result added one GET. Repeating the same put added one PUT and one collision-verification GET. These counts exclude network client requests and SQLite operations.

The actual-workerd query-plan test seeded 1,001 terminal receipts, 1,000 released guards and one active guard. It verified these plans without benchmarking latency:

```text
SEARCH receipt_attempts USING COVERING INDEX receipt_attempt_recovery (kind=? AND id>?)
SEARCH receipt_exports USING COVERING INDEX receipt_export_recovery (token>?)
SEARCH receipt_exports USING INDEX receipt_export_volume (volume=?)
```

Commands executed successfully after restoration:

```sh
bunx biome check --write apps/cloud/src/receipts*.ts apps/cloud/src/environment.ts apps/cloud/src/worker.ts apps/cloud/wrangler.jsonc apps/sandbox/src/http-authority.ts packages/loopy/_tests_/cloud-receipt*.test.ts packages/loopy/_tests_/fixtures/receipt-*.ts
bunx eslint --fix apps/cloud/src/receipts*.ts apps/cloud/src/environment.ts apps/cloud/src/worker.ts apps/sandbox/src/http-authority.ts packages/loopy/_tests_/cloud-receipt*.test.ts packages/loopy/_tests_/fixtures/receipt-*.ts
bunx tsc --noEmit --target ES2022 --lib ES2022,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --skipLibCheck --types bun-types apps/cloud/src/receipts*.ts apps/sandbox/src/http-authority.ts packages/loopy/_tests_/cloud-receipt*.test.ts packages/loopy/_tests_/fixtures/receipt-*.ts
bun test --timeout 60000 packages/loopy/_tests_/cloud-receipt*.test.ts
git diff --check -- apps/cloud/src/environment.ts apps/cloud/src/worker.ts apps/cloud/wrangler.jsonc apps/cloud/src/receipts*.ts apps/sandbox/src/http-authority.ts
```

Biome checked 19 files. ESLint and TypeScript exited zero without diagnostics. The final test run printed `18 pass`, `0 fail`, `99 expect() calls`. No broad full check was run.

Seven negative controls each exited 1 at an assertion. Original bytes were restored in `finally` after every mutation:

- Return created for duplicate admission: expected one created reply, received twelve.
- Remove request-hash comparison: expected request conflict, received existing.
- Remove session fencing: expected stale rejection, received existing.
- Remove export exclusion from admission: expected workspace busy, received created.
- Remove byte verification before SQL completion: expected rejection, completion resolved.
- Remove R2 conditional create: expected corrupt collision rejection, put resolved.
- Remove R2 digest verification: expected changed-content rejection, get resolved.

Logs and the control report are in `.loopy/architecture-tests/receipts-negative-hrpiyo7m/`. `report.json` records the source hash for each mutation. `final-source-manifest.json` records the final owned source/test hashes. The recovery indexes were added after those controls; the final focused tests and exact EXPLAIN assertions cover the restored current source.

# File hashes and line changes

This is a new adapter with tests, rather than removal of a prior adapter. Owned source/config/tests add 1,981 lines and delete 3 against starting HEAD. The largest production file has 232 lines; the largest test has 243. The implementation note is additional documentation. No casts other than `as const`, `any`, shared schema-16 migration, triggers or totals table were introduced.

```text
added deleted sha256 path
    5       0 e7451f857f97bc60eeb7a571bd9e6e4d41e9d09014a5b95248820827a666ea4e apps/cloud/src/environment.ts
  168       0 93a512f373767ca8534edccc46dd63609103e2e450cfb3af162833e47f79d01b apps/cloud/src/receipts-authority.ts
   38       0 4f848c2e75493586b5363faf37831800b6ffc8f42fa0395cd688e1969c74c14a apps/cloud/src/receipts-identity.ts
   75       0 ac678301001426ef48604b4f9290cc59b5b2315b110c793c78a4c9b1e537f546 apps/cloud/src/receipts-results.ts
  101       0 a7a9dfa5dc19a6f1cfe6ddb904bcee5e9205084331d09e5c7e38aecbfb94b78b apps/cloud/src/receipts-route.ts
  232       0 d31e806eb53a226318555f2e5f9af58007558f0d7210af98369fc47c5073cd25 apps/cloud/src/receipts-sql.ts
  136       0 59b1e32e496e8264fcfccfa257f2a9699b27be6f1be670cf8a83a480c64cbb82 apps/cloud/src/receipts.ts
    7       0 7152d2b103391c4bfef3f5c6a7640509c3534a75626fb1cced8386c24ecae2c5 apps/cloud/src/worker.ts
   12       3 0e190391ca0d657ff76cdebdcdc8d8348449f85b975c7c778f7d761bfc4a3990 apps/cloud/wrangler.jsonc
  160       0 6755f03bed8ec66b41d6bb6933f3a136f6b01494c09abda577c7f52e758cc184 apps/sandbox/src/http-authority.ts
  243       0 d0b8268849b0c0fe3f35cbc3b3faefc680287846da1a821b1fe29503d91c8c46 packages/loopy/_tests_/cloud-receipt-authority.test.ts
  131       0 edf9a16832124c350e1ef94b3eae3827e05d477a5e7aa1bb530f9e99fc68050b packages/loopy/_tests_/cloud-receipt-export.test.ts
  160       0 ec244f8577107ec9c7dd01f08cabc96259fcb72b4a6288c61bef5b5a34a02fc1 packages/loopy/_tests_/cloud-receipt-http.test.ts
   47       0 501bf33962805961e9844c4ff3bac3b6e2915bc9f577fb13de73cb4929eb95c7 packages/loopy/_tests_/cloud-receipt-recovery.test.ts
  185       0 5048187f4a8bd5f97732c3a66b291c46ad82d29e38b9e6d8950d5e9bd60706a7 packages/loopy/_tests_/cloud-receipt-results.test.ts
   40       0 8aff9f754d8a412ff36f87143ca9cb2a0376e7df8452fc602e3fbbc50ad820ed packages/loopy/_tests_/fixtures/receipt-count-probe.ts
  130       0 2fccce5434d45ebf849d3291de0c4a4014f9f7422b3c04e9e94322109d9d8202 packages/loopy/_tests_/fixtures/receipt-harness.ts
   72       0 ab9572aeb994ccb96e9e44835ab3ed7dea1804400aa0d9d39303012ce1f622e0 packages/loopy/_tests_/fixtures/receipt-recovery-probe.ts
   39       0 e2ec681ec1dbef6b55a8d232d3ab91dee7241fae1bb2cc13079e85fe6d76847b packages/loopy/_tests_/fixtures/receipt-rollback-probe.ts
```

# Remaining limits and root gates

Local Miniflare/workerd tests establish the tested SQLite/R2 and HTTP behavior. They do not establish remote Cloudflare durability, replication, power-loss behavior, Docker command fencing, physical worker lifetime during monitor outage or exactly-once arbitrary external effects. SQL fencing does not fence delayed Docker operations. The bridge must retain its OS root lock and verify resource ownership.

The query-plan test is a bounded access-path check, not a latency benchmark. Responses and requests are capped at the transport boundary; large recovery payloads may require a smaller requested page. The fixture's corruption and EXPLAIN operations run only inside dedicated test DO classes. No production inspection or fault-injection endpoint was added.

The sandbox lane still owns helper-absence verification, start-once reconciliation and monitor retention, filesystem compatibility, shutdown ordering, populated-filesystem-root refusal and startup factory selection. Root must verify launcher configuration and actual durable selection through the fresh live Docker workload, run broader integration acceptance and handle any final branch/main work. This lane ran no Docker workload, no Wrangler deployment, no cloud provisioning and no full repository gate. There is no automatic filesystem fallback or importer in this adapter.
