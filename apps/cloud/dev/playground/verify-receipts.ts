import { resolve } from "node:path";
import { executionKeyString } from "@loopy/core";
import { Effect } from "effect";
import { sha256Hex } from "../shared/hash";
import { config, evidence, sandboxState, state } from "./config";
import { atomic } from "./files";
import { journalDirectory } from "./journal";
import { postloadInventory, readArtifact } from "./metrics/artifacts";
import { planTotals } from "./plan";
import { receiptEvidence } from "./receipt/evidence";
import { receiptInventory } from "./receipt/inventory";
import { receiptAuthority, requireFreshDurableRoot } from "./receipt/selection";
import { catalogs } from "./repository";
import { decodeRuntimeQueue, runtimeQueuePath, unresolvedOutcomes } from "./runtime-queue";

const QUEUE_LIMIT_BYTES = 16 * 1024 * 1024;

const settings = await config();

if (settings.receiptMode !== "durable-object") {
  throw new Error("Receipt verification requires the architecture profile's durable authority.");
}

const runIds = await receiptInventory({
  inventory: await readArtifact(evidence, postloadInventory),
  plan: planTotals(await catalogs()),
  batch: settings.batch,
  journal: journalDirectory(state),
});

const queueFile = Bun.file(runtimeQueuePath(state));

if (queueFile.size > QUEUE_LIMIT_BYTES) {
  throw new Error("Runtime receipt inventory exceeds its 16 MiB verification limit.");
}

const queueBytes = await queueFile.text();

const queueHash = sha256Hex(queueBytes);

const entries = queueBytes
  .trim()
  .split("\n")
  .map((line) => decodeRuntimeQueue(JSON.parse(line)));

const unresolved: readonly string[] = unresolvedOutcomes;

const identities = new Set<string>();

for (const entry of entries) {
  const identity = `${executionKeyString(entry.executionKey)}/${entry.attempt}`;

  if (
    identities.has(identity) ||
    !runIds.has(entry.executionKey.runId) ||
    unresolved.includes(entry.outcome)
  ) {
    throw new Error("Runtime journal contains a duplicate, foreign or unresolved attempt.");
  }

  identities.add(identity);
}

const authority = receiptAuthority(settings);

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

await requireFreshDurableRoot(sandboxState);

if (sha256Hex(await queueFile.text()) !== queueHash) {
  throw new Error("Runtime journal changed during terminal receipt verification.");
}

const output = resolve(evidence, "playground-durable-receipts.json");

atomic(output, {
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
