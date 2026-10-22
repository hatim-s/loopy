import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { atomic, root } from "./config.js";
import { lifecycle } from "./metrics-lifecycle.js";
import { diagnosticPath } from "./metrics-snapshot.js";
import { DiagnosticDriver } from "./metrics-sql-driver.js";
import { sqlCases } from "./metrics-sql-queries.js";
import { distribution } from "./metrics-statistics.js";

const [phase, supplied] = z
  .tuple([z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), z.string().min(1)])
  .parse(process.argv.slice(2));

const path = await diagnosticPath(supplied);

const expectedHash = "0d0ce744814caf442edf3c3fde3e74b129019f7602db4bb393a431cd341697fa";

const sha256 = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

const beforeHash = await sha256(path);

if (beforeHash !== expectedHash || !path.endsWith("/standalone/diagnostic.sqlite")) {
  throw new Error("Only the root-verified standalone snapshot is approved for final SQL evidence.");
}

const sources = [
  "packages/loopy/src/store/sqlite/query-runs.ts",
  "packages/loopy/src/store/sqlite/query-feeds.ts",
  "packages/loopy/src/store/sqlite/query-nodes.ts",
  "packages/loopy/src/store/sqlite/schema.ts",
  "apps/cloud/src/scheduler.ts",
  "apps/cloud/src/sql-driver.ts",
  "scripts/playground/metrics-sql-queries.ts",
];

const sourceHashes = await Promise.all(
  sources.map(async (file) => ({ file, sha256: await sha256(resolve(root, file)) })),
);

const pendingSource = await readFile(resolve(root, sources[0] ?? ""), "utf8");

const sourceState = pendingSource.includes("json_each(?)")
  ? "after-json-each-pagination-edit"
  : "before-json-each-pagination-edit";

const sidecarsBefore = await readdir(dirname(path));

const driver = new DiagnosticDriver(path);

let closed = false;

try {
  const inventory = z
    .object({ runs: z.array(z.object({ id: z.string(), status: z.string() })) })
    .parse(
      await Bun.file(
        resolve(root, ".notes/cloud/evidence/playground-performance-postload-inventory.json"),
      ).json(),
    );

  const actual = driver.db
    .query<{ id: string; status: string }, []>("SELECT id,status FROM runs ORDER BY id")
    .all();

  const expected = [...inventory.runs].sort((a, b) => a.id.localeCompare(b.id));

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Diagnostic run identities differ from post-load API inventory.");
  }

  const integrity = driver.db.query("PRAGMA integrity_check").all();
  const cases = sqlCases(driver.db);
  const results = [];

  for (const item of cases) {
    driver.operation = item.name;
    const elapsed = [];
    let rows = 0;
    let resultDigest = "";

    for (let repeat = 0; repeat < 10; repeat++) {
      const began = performance.now();
      const result = driver.query(item.sql).all(...item.bindings);
      elapsed.push(performance.now() - began);
      rows = result.length;
      resultDigest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    }

    results.push({
      name: item.name,
      source: item.source,
      bindings: item.bindings.length,
      rows,
      resultDigest,
      operationMs: distribution(elapsed),
    });
  }

  const counts = [
    "runs",
    "node_runs",
    "node_attempts",
    "node_scopes",
    "logs",
    "events",
    "waits",
    "cloud_turns",
  ].map((table) => ({
    table,
    rows:
      driver.db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()
        ?.count ?? 0,
  }));

  const schema = driver.db
    .query(
      "SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index') AND name NOT LIKE '_cf%' AND name NOT LIKE '__cf%' ORDER BY type,name",
    )
    .all();

  const pragmas = Object.fromEntries(
    [
      "journal_mode",
      "page_size",
      "page_count",
      "freelist_count",
      "user_version",
      "schema_version",
      "foreign_keys",
    ].map((name) => [name, driver.db.query(`PRAGMA ${name}`).get()]),
  );

  const report = {
    scope: "root-approved-standalone-readonly-sql",
    phase,
    at: new Date().toISOString(),
    path,
    beforeHash,
    sourceState,
    sourceHashes,
    integrity,
    inventory: { matched: true, ids: actual.length },
    sqlite: driver.db.query("SELECT sqlite_version() AS version").get(),
    pragmas,
    schema,
    counts,
    queries: driver.traces,
    querySummaries: driver.summary(),
    results,
    lifecycle: await lifecycle(driver.db),
    sidecarsBefore,
    limits: [
      "No SqlRunStore constructor,migrations,SQL writes or live/raw/working database access.",
      "Exact SQL shapes use source constants/projections;historical IN and current json_each run on the same immutable diagnostic copy.",
      "Native SQLite does not reproduce Workerd binding ceilings;successful native200-binding queries are not runtime parity proof.",
      "Ten warm-cache repetitions on a shared host while daemon45 runs are local diagnostics,not a controlled hardware benchmark or production p99.",
      "SQL duration excludes EXPLAIN and result hashing;operation duration includes first EXPLAIN. JSON row-to-view conversion and post-scan feed filtering are not measured.",
      "No new indexes,ANALYZE,checkpoint or persisted pragma changes were performed by this probe.",
    ],
  };

  driver.db.close();
  closed = true;
  const afterHash = await sha256(path);

  if (afterHash !== beforeHash) {
    throw new Error("Read-only diagnostic source hash changed.");
  }

  const afterSources = await Promise.all(
    sources.map(async (file) => ({ file, sha256: await sha256(resolve(root, file)) })),
  );

  const output = resolve(root, ".notes/cloud/evidence", `playground-performance-${phase}-sql.json`);

  if (await Bun.file(output).exists()) {
    throw new Error("SQL evidence exists. Choose a new phase.");
  }

  await atomic(output, {
    ...report,
    afterHash,
    sourceHashesAfter: afterSources,
    sourceUnchangedDuringProbe: JSON.stringify(afterSources) === JSON.stringify(sourceHashes),
    sidecarsAfter: await readdir(dirname(path)),
  });
  process.stdout.write(`${JSON.stringify({ output, sourceState, counts, results })}\n`);
} finally {
  if (!closed) {
    driver.db.close();
  }
}
