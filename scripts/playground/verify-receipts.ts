import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { HttpSandboxAuthority } from "../../apps/sandbox/src/http-authority.js";
import { executionKeyString } from "../../packages/loopy/src/core/index.js";
import { atomic, config, evidenceDirectory, profile, sandboxState, state } from "./config.js";
import { receiptEvidence } from "./receipt-evidence.js";
import { receiptInventory } from "./receipt-inventory.js";
import { decodeRuntimeQueue } from "./runtime-queue-schema.js";

if (profile.name !== "architecture") {
  throw new Error("Receipt verification requires the isolated architecture profile.");
}

const settings = await config();

if (settings.receiptMode !== "durable-object") {
  throw new Error("Receipt verification requires the selected durable authority.");
}

const runIds = await receiptInventory({
  inventory: await Bun.file(
    resolve(evidenceDirectory, "playground-performance-postload-inventory.json"),
  ).json(),
  batch: settings.batch,
  journal: resolve(state, "journal"),
});

const queueFile = Bun.file(resolve(state, "runtime-queue.jsonl"));

if (queueFile.size > 16 * 1024 * 1024) {
  throw new Error("Runtime receipt inventory exceeds its 16 MiB verification limit.");
}

const queueBytes = await queueFile.text();

const queueHash = createHash("sha256").update(queueBytes).digest("hex");

const entries = queueBytes
  .trim()
  .split("\n")
  .map((line) => decodeRuntimeQueue(JSON.parse(line)));

const identities = new Set<string>();

for (const entry of entries) {
  const identity = `${executionKeyString(entry.executionKey)}/${entry.attempt}`;

  if (
    identities.has(identity) ||
    !runIds.has(entry.executionKey.runId) ||
    ["uncertain", "transport-exception", "expired-in-queue"].includes(entry.outcome)
  ) {
    throw new Error("Runtime journal contains a duplicate, foreign or unresolved attempt.");
  }

  identities.add(identity);
}

const authority = new HttpSandboxAuthority({
  url: settings.api,
  token: settings.receiptsToken,
  namespace: profile.batchPrefix,
});

const startedAt = new Date().toISOString();

const records = [];

for (const entry of entries) {
  const started = performance.now();

  const checked = await Effect.runPromise(
    receiptEvidence({
      root: sandboxState,
      identity: {
        workspace: settings.workspace,
        executionKey: entry.executionKey,
        attempt: entry.attempt,
      },
      authority,
      resultsFor: (workspace) => authority.resultsFor(workspace),
    }),
  );

  if (checked.resultKind !== (entry.outcome === "succeeded" ? "succeeded" : "failed")) {
    throw new Error("Authoritative result differs from the observed backend outcome.");
  }

  const { session, ...record } = checked;
  records.push({ ...record, sessionEpoch: session.epoch });

  if (records.length % 100 === 0) {
    console.log(JSON.stringify({ verified: records.length, total: entries.length }));
  }

  await Bun.sleep(Math.max(0, 100 - (performance.now() - started)));
}

for (const directory of ["receipts", "exports"]) {
  if ((await readdir(resolve(sandboxState, directory))).length !== 0) {
    throw new Error("Durable mode unexpectedly populated filesystem authority records.");
  }
}

if (
  createHash("sha256")
    .update(await queueFile.text())
    .digest("hex") !== queueHash
) {
  throw new Error("Runtime journal changed during terminal receipt verification.");
}

const output = resolve(evidenceDirectory, "playground-durable-receipts.json");

await atomic(output, {
  status: "passed",
  batch: settings.batch,
  startedAt,
  finishedAt: new Date().toISOString(),
  receiptMode: settings.receiptMode,
  runCount: runIds.size,
  backendAttempts: entries.length,
  verifiedReceipts: records.length,
  queueHash,
  filesystemAuthorityRecords: 0,
  records,
  limits: [
    "Reads every completed backend-start identity in the local runtime journal through the authority and immutable-result APIs.",
    "Does not enumerate unreferenced R2 blobs or prove the authority has no additional records; the stopped SQL copy supplies the latter check.",
    "Sequential read-only verification runs after performance capture, capped at ten receipt/result pairs per second.",
  ],
});

console.log(JSON.stringify({ output, verifiedReceipts: records.length }));
