import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { state } from "./config.js";
import { admissionSchema } from "./journal.js";
import { distribution } from "./metrics-statistics.js";

function elapsed(from: string | null, to: string | null) {
  if (from === null || to === null) {
    return null;
  }

  const value = Date.parse(to) - Date.parse(from);

  return Number.isFinite(value) && value >= 0 ? value : null;
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

  const runs = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    status: row.status,
    queueToClaimMs: elapsed(row.createdAt, row.claimedAt),
    queueToFirstNodeMs: elapsed(row.createdAt, row.firstNodeAt),
    terminalFromCreationMs: ["succeeded", "failed", "cancelled"].includes(row.status)
      ? elapsed(row.createdAt, row.updatedAt)
      : null,
    terminalFromClaimMs: ["succeeded", "failed", "cancelled"].includes(row.status)
      ? elapsed(row.claimedAt, row.updatedAt)
      : null,
  }));

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

  const admission: {
    runId: string | null;
    phase: "primary" | "preflight";
    admissionMs: number | null;
  }[] = [];

  let invalidJournalFiles = 0;
  const glob = new Bun.Glob("**/*.json");
  const journal = resolve(state, "journal");

  const journalExists = await stat(journal).then(
    (value) => value.isDirectory(),
    () => false,
  );

  for await (const path of glob.scan({
    cwd: journalExists ? journal : resolve(state, "diagnostics"),
    absolute: true,
    onlyFiles: true,
  })) {
    if (path.endsWith(".progress.json")) {
      continue;
    }

    const parsed = admissionSchema.safeParse(await Bun.file(path).json());

    if (!parsed.success) {
      invalidJournalFiles++;
      continue;
    }

    admission.push({
      runId: parsed.data.runId ?? null,
      phase: parsed.data.phase,
      admissionMs: elapsed(parsed.data.intentAt, parsed.data.admittedAt ?? null),
    });
  }

  const numeric = (values: (number | null)[]) => values.filter((value) => value !== null);

  const primaryIds = new Set(
    admission.flatMap((item) =>
      item.runId === null || item.phase !== "primary" ? [] : [item.runId],
    ),
  );

  const primary = runs.filter((run) => primaryIds.has(run.id));

  const summarize = (selected: typeof runs) => ({
    runs: selected.length,
    statuses: Object.fromEntries(
      [...new Set(selected.map((run) => run.status))].map((status) => [
        status,
        selected.filter((run) => run.status === status).length,
      ]),
    ),
    queueToClaimMs: distribution(numeric(selected.map((run) => run.queueToClaimMs))),
    queueToFirstNodeMs: distribution(numeric(selected.map((run) => run.queueToFirstNodeMs))),
    terminalFromCreationMs: distribution(
      numeric(selected.map((run) => run.terminalFromCreationMs)),
    ),
    terminalFromClaimMs: distribution(numeric(selected.map((run) => run.terminalFromClaimMs))),
  });

  return {
    allRetained: summarize(runs),
    primaryJournalRuns: summarize(primary),
    admissionMs: distribution(numeric(admission.map((item) => item.admissionMs))),
    journalFiles: admission.length,
    invalidJournalFiles,
    nodeAttemptDurationMs: distribution(
      numeric(attempts.map((attempt) => elapsed(attempt.startedAt, attempt.endedAt))),
    ),
    completedWaitMs: distribution(
      numeric(waits.map((wait) => elapsed(wait.createdAt, wait.resolvedAt ?? wait.expiredAt))),
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
