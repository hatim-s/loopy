import { join } from "node:path";
import { Schema } from "effect";
import { sha256Hex } from "../shared/hash";
import { distribution } from "../shared/stats";
import { closedDatabase, closedExecutions } from "./closed-executions";
import { evidencePath, writeEvidence } from "./config";
import { preflightSchema, reportSchema } from "./report-schema";
import { requireEqual, validators } from "./semantics";

export async function analyze() {
  // Retained evidence carries many more fields than analysis reads, so excess keys are ignored.
  const report = Schema.decodeUnknownSync(reportSchema)(await Bun.file(evidencePath("")).json());

  const executions = closedExecutions();
  await writeEvidence("-executions", {
    source: closedDatabase,
    access: "Bun Database readonly with SELECT only; no store constructor or migration",
    records: executions,
  });

  const preflight = Schema.decodeUnknownSync(preflightSchema)(
    await Bun.file(evidencePath("-preflight")).json(),
  );

  for (const execution of executions) {
    const expected = preflight.revisions.find((revision) => revision.slug === execution.slug);

    if (!expected) {
      throw new Error(`Frozen revision is absent for ${execution.slug}.`);
    }

    requireEqual(execution.revision, expected.revision, "pinned graph revision");
  }

  let verifiedFiles = 0;

  for (const record of report.records) {
    for (const file of record.outputs) {
      const bytes = await Bun.file(join(record.outputDirectory, file.path)).bytes();
      requireEqual(bytes.length, file.bytes, "retained file byte count");
      requireEqual(sha256Hex(bytes), file.sha256, "retained file hash");
      verifiedFiles++;
    }

    const validate = validators.get(record.slug);

    if (!validate) {
      throw new Error(`No semantic validator for ${record.slug}.`);
    }

    const full = executions.find((execution) => execution.id === record.run.id);

    if (!full) {
      throw new Error(`Run ${record.run.id} is missing from the verified closed backup.`);
    }

    await validate({ ...record, nodeRuns: full.nodes });
  }

  const restarted = report.records.find((record) => record.run.id === report.restartProof.runId);

  if (!restarted) {
    throw new Error("Restarted run is absent from completed evidence.");
  }

  for (const receipt of report.restartProof.before) {
    requireEqual(
      restarted.receipts.some(
        (final) => final.path === receipt.path && final.sha256 === receipt.sha256,
      ),
      true,
      "finished seed receipt reused through completion",
    );
  }

  const summary = {
    verifiedRuns: report.records.length,
    verifiedFiles,
    wallMs: Date.parse(report.endedAt) - Date.parse(report.startedAt),
    admissionMs: distribution(report.records.map((record) => record.admissionMs)),
    observedCompletionMs: distribution(report.records.map((record) => record.observedMs)),
    serverLifecycleMs: distribution(
      report.records.map(
        (record) => Date.parse(record.run.updatedAt) - Date.parse(record.run.createdAt),
      ),
    ),
    firstRecordedNodeDelayMs: distribution(
      report.records.map(
        (record) =>
          Date.parse(record.firstNodeStartedAt ?? record.run.createdAt) -
          Date.parse(record.run.createdAt),
      ),
    ),
    holdsMs: distribution(
      report.records.flatMap((record) => (record.hold ? [record.hold.heldMs] : [])),
    ),
    finishedEffectReceipts: report.records.reduce(
      (count, record) => count + record.receipts.length,
      0,
    ),
    latestExecutions: executions.reduce((count, record) => count + record.nodes.length, 0),
    executionAttempts: executions.reduce((count, record) => count + record.attempts.length, 0),
    scopedExecutions: executions.reduce(
      (count, record) => count + record.nodes.filter((node) => node.key.scope.length > 0).length,
      0,
    ),
    logs: executions.reduce((count, record) => count + record.logs.length, 0),
    fullExecutionCounts: executions.map((record) => ({
      runId: record.id,
      slug: record.slug,
      nodes: record.nodes.length,
      attempts: record.attempts.length,
      logs: record.logs.length,
    })),
    perWorkflow: [...validators.keys()].map((slug) => ({
      slug,
      runs: report.records.filter((record) => record.slug === slug).length,
      succeeded: report.records.filter(
        (record) => record.slug === slug && record.run.status === "succeeded",
      ).length,
    })),
    seedReceiptReusedThroughFinalCompletion: true,
    allPinnedRevisionsMatchPreflight: true,
    timingBoundary:
      "Observed completion includes 200ms polling and output-capture overhead. First recorded node delay is not a worker-dispatch measurement. Serial behavior/recovery exercise, not maximum throughput or hardware-matched cloud comparison.",
  };

  await writeEvidence("-semantics", summary);
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) {
  await analyze();
}
