import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { decodeBoundary, isTerminalRun, runStatusSchema } from "@loopy/contract";
import { errnoCode } from "@loopy/core";
import { distribution } from "../../shared/stats";
import { state } from "../config";
import { journalDirectory, readAdmissions } from "../journal";
import { countBy, elapsedMs, known } from "./statistics";

const decodeStatus = decodeBoundary(runStatusSchema);

// A diagnostic copy can be analyzed before any driver journal exists.
async function journalAdmissions() {
  const journal = journalDirectory(state);

  try {
    await stat(journal);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") {
      return [];
    }

    throw cause;
  }

  return readAdmissions(journal);
}

export async function lifecycle(db: Database) {
  const rows = db
    .query<
      {
        id: string;
        slug: string;
        status: string;
        createdAt: string;
        updatedAt: string;
        claimedAt: string | null;
        firstNodeAt: string | null;
      },
      []
    >(`SELECT r.id,r.slug,r.status,r.created_at AS createdAt,r.updated_at AS updatedAt,
    (SELECT min(at) FROM events e WHERE e.run_id=r.id AND e.entity='run' AND e.kind='claimed') AS claimedAt,
    (SELECT min(started_at) FROM node_runs n WHERE n.run_id=r.id) AS firstNodeAt
    FROM runs r ORDER BY r.created_at,r.id`)
    .all();

  const runs = rows.map((row) => {
    const terminal = isTerminalRun(decodeStatus(row.status));

    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      queueToClaimMs: elapsedMs(row.createdAt, row.claimedAt),
      queueToFirstNodeMs: elapsedMs(row.createdAt, row.firstNodeAt),
      terminalFromCreationMs: terminal ? elapsedMs(row.createdAt, row.updatedAt) : null,
      terminalFromClaimMs: terminal ? elapsedMs(row.claimedAt, row.updatedAt) : null,
    };
  });

  const attempts = db
    .query<{ status: string; startedAt: string; endedAt: string | null; receipt: string }, []>(
      "SELECT json_extract(record,'$.status') AS status,json_extract(record,'$.startedAt') AS startedAt,json_extract(record,'$.endedAt') AS endedAt,json_extract(record,'$.receipt') AS receipt FROM node_attempts",
    )
    .all();

  const waits = db
    .query<{ createdAt: string; resolvedAt: string | null; expiredAt: string | null }, []>(
      "SELECT json_extract(record,'$.createdAt') AS createdAt,json_extract(record,'$.resolvedAt') AS resolvedAt,json_extract(record,'$.expiredAt') AS expiredAt FROM waits",
    )
    .all();

  const admission = (await journalAdmissions()).map((value) => ({
    runId: value.runId,
    phase: value.phase,
    admissionMs: elapsedMs(value.intentAt, value.admittedAt),
  }));

  const primaryIds = new Set(
    admission.flatMap((item) =>
      item.runId === null || item.phase !== "primary" ? [] : [item.runId],
    ),
  );

  const primary = runs.filter((run) => primaryIds.has(run.id));

  const summarize = (selected: typeof runs) => ({
    runs: selected.length,
    statuses: countBy(selected, (run) => run.status),
    queueToClaimMs: distribution(known(selected.map((run) => run.queueToClaimMs))),
    queueToFirstNodeMs: distribution(known(selected.map((run) => run.queueToFirstNodeMs))),
    terminalFromCreationMs: distribution(known(selected.map((run) => run.terminalFromCreationMs))),
    terminalFromClaimMs: distribution(known(selected.map((run) => run.terminalFromClaimMs))),
  });

  return {
    allRetained: summarize(runs),
    primaryJournalRuns: summarize(primary),
    admissionMs: distribution(known(admission.map((item) => item.admissionMs))),
    journalFiles: admission.length,
    nodeAttemptDurationMs: distribution(
      known(attempts.map((attempt) => elapsedMs(attempt.startedAt, attempt.endedAt))),
    ),
    completedWaitMs: distribution(
      known(waits.map((wait) => elapsedMs(wait.createdAt, wait.resolvedAt ?? wait.expiredAt))),
    ),
    pendingWaits: waits.filter((wait) => wait.resolvedAt === null && wait.expiredAt === null)
      .length,
    runs,
    admission,
    limits: [
      "Claim latency uses retained claimed events; absent events produce null, never zero.",
      "First node includes control nodes and is not provider execution admission.",
      "Terminal wall time includes queue, execution, scheduler polling and approval holds.",
      "Node attempt duration includes waiting/control nodes and is not isolated CPU time.",
      "Primary run identity comes from driver journals; retained historical runs are reported separately.",
    ],
  };
}
