import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { atomic } from "../playground/config";
import { sqlCases } from "../playground/metrics/sql-queries";
import { evidence as evidenceDirectory, state } from "./config";

const path = resolve(state, "daemon-readonly.sqlite");

const sha256 = async () =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const beforeHash = await sha256();

const evidence = z
  .object({
    apiRuns: z.array(z.object({ id: z.string(), status: z.string() })),
    startedAt: z.string(),
    endedAt: z.string(),
  })
  .parse(await Bun.file(resolve(evidenceDirectory, "playground-daemon.json")).json());

const db = new Database(path, { readonly: true });

let report;

try {
  const actual = db
    .query<{ id: string; status: string }, []>("SELECT id,status FROM runs ORDER BY id")
    .all();

  const expected = [...evidence.apiRuns].sort((a, b) => a.id.localeCompare(b.id));

  if (actual.length !== 45 || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Supplied daemon backup does not match all45 API IDs/statuses.");
  }

  const selected = new Set([
    "runs.latest",
    "runs.failed",
    "counts.all",
    "logs.candidates",
    "events.candidates",
    "executions.page",
    "execution.attempts",
  ]);

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

  const counts = [
    "runs",
    "node_runs",
    "node_attempts",
    "node_scopes",
    "logs",
    "events",
    "waits",
  ].map((table) => ({
    table,
    rows:
      db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0,
  }));

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
    daemonInterval: { startedAt: evidence.startedAt, endedAt: evidence.endedAt },
    counts,
    plans,
    limits: [
      "Only supplied daemon-readonly.sqlite was opened;no live home DB,API requests,restarts,migrations or writes.",
      "No query timings collected. Host Bun/SQLite differs from cloud DO/Docker.",
      "Plans identify mechanisms for this45-run data;they do not establish production scalability or runtime parity.",
      "The cloud-native timing artifact and daemon plans are not a controlled hardware comparison.",
    ],
  };
} finally {
  db.close();
}

const afterHash = await sha256();

if (beforeHash !== afterHash) {
  throw new Error("Readonly daemon backup hash changed.");
}

const output = resolve(evidenceDirectory, "playground-performance-daemon-offline-sql.json");

await atomic(output, { ...report, afterHash });

process.stdout.write(
  `${JSON.stringify({ output, counts: report.counts, inventory: report.inventory, beforeHash, afterHash })}\n`,
);
