import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { Schema } from "effect";
import { atomic } from "../playground/files";
import {
  fileSha256,
  requireRunInventory,
  runTables,
  tableCounts,
} from "../playground/metrics/sql-probe";
import { sqlCases } from "../playground/metrics/sql-queries";
import { closedDatabase } from "./closed-executions";
import { evidence, evidencePath } from "./config";
import { PLANNED_RUNS } from "./plan";

const path = closedDatabase;

const beforeHash = await fileSha256(path);

// Only the run inventory and interval are read from the daemon playground's own report.
const daemonReport = Schema.decodeUnknownSync(
  Schema.Struct({
    apiRuns: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
    startedAt: Schema.String,
    endedAt: Schema.String,
  }),
)(await Bun.file(evidencePath("")).json());

const selected = new Set([
  "runs.latest",
  "runs.failed",
  "counts.all",
  "logs.candidates",
  "events.candidates",
  "executions.page",
  "execution.attempts",
]);

const db = new Database(path, { readonly: true });

let report;

try {
  if (daemonReport.apiRuns.length !== PLANNED_RUNS) {
    throw new Error(`Daemon report must list all ${PLANNED_RUNS} API runs.`);
  }

  const actual = requireRunInventory(
    db,
    daemonReport.apiRuns,
    `Supplied daemon backup does not match all ${PLANNED_RUNS} API IDs/statuses.`,
  );

  const plans = sqlCases(db).flatMap((item) =>
    selected.has(item.name)
      ? [
          {
            name: item.name,
            source: item.source,
            sql: item.sql,
            parameterCount: item.bindings.length,
            plan: db.query(`EXPLAIN QUERY PLAN ${item.sql}`).all(...item.bindings),
          },
        ]
      : [],
  );

  report = {
    scope: "supplied-stopped-daemon-backup-readonly-identity-and-plans",
    at: new Date().toISOString(),
    path,
    beforeHash,
    integrity: db.query("PRAGMA integrity_check").all(),
    journal: db.query("PRAGMA journal_mode").get(),
    inventory: {
      matched: true,
      ids: actual.length,
      statuses: db.query("SELECT status,count(*) AS count FROM runs GROUP BY status").all(),
    },
    daemonInterval: { startedAt: daemonReport.startedAt, endedAt: daemonReport.endedAt },
    counts: tableCounts(db, runTables),
    plans,
    limits: [
      "Only supplied daemon-readonly.sqlite was opened;no live home DB,API requests,restarts,migrations or writes.",
      "No query timings collected. Host Bun/SQLite differs from cloud DO/Docker.",
      `Plans identify mechanisms for this ${PLANNED_RUNS}-run data;they do not establish production scalability or runtime parity.`,
      "The cloud-native timing artifact and daemon plans are not a controlled hardware comparison.",
    ],
  };
} finally {
  db.close();
}

const afterHash = await fileSha256(path);

if (beforeHash !== afterHash) {
  throw new Error("Readonly daemon backup hash changed.");
}

const output = resolve(evidence, "playground-performance-daemon-offline-sql.json");

atomic(output, { ...report, afterHash });

process.stdout.write(
  `${JSON.stringify({ output, counts: report.counts, inventory: report.inventory, beforeHash, afterHash })}\n`,
);
