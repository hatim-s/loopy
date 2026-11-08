import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { sha256Hex } from "../../shared/hash";
import { SQL_PROBE_SOURCES, sourceHashes } from "../../shared/sources";
import { distribution } from "../../shared/stats";
import { root } from "../../stack/constants";
import { config, evidence, profile, state } from "../config";
import { atomic } from "../files";
import {
  artifactPath,
  decodePhaseName,
  postloadInventory,
  readArtifact,
  sqlReport,
} from "./artifacts";
import { lifecycle } from "./lifecycle";
import { approvedDiagnostic, diagnosticPath } from "./snapshot";
import { DiagnosticReader } from "./sql-driver";
import { fileSha256, requireRunInventory, runTables, tableCounts } from "./sql-probe";
import { sqlCases } from "./sql-queries";

const phase = decodePhaseName(process.argv[2]);

const supplied = decodeBoundary(Schema.String.check(Schema.isMinLength(1)))(process.argv[3]);

const diagnostics = resolve(state, "diagnostics");

const path = await diagnosticPath(supplied, diagnostics);

const beforeHash = await approvedDiagnostic({
  path,
  approvalPath: resolve(diagnostics, "closed-copy.json"),
  batch: (await config()).batch,
  profile: profile.label,
});

const hashSources = () => sourceHashes(root, SQL_PROBE_SOURCES);

const beforeSources = await hashSources();

const sidecarsBefore = await readdir(dirname(path));

const reader = new DiagnosticReader(path);

let closed = false;

try {
  const inventory = await readArtifact(evidence, postloadInventory);

  const actual = requireRunInventory(
    reader.db,
    inventory.runs,
    "Diagnostic run identities differ from post-load API inventory.",
  );

  const integrity = reader.db.query("PRAGMA integrity_check").all();
  const results = [];

  for (const item of sqlCases(reader.db)) {
    const elapsed = [];
    let rows = 0;
    let resultDigest = "";

    for (let repeat = 0; repeat < 10; repeat++) {
      const began = performance.now();
      const result = reader.all(item.name, item.sql, item.bindings);
      elapsed.push(performance.now() - began);
      rows = result.length;
      resultDigest = sha256Hex(JSON.stringify(result));
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

  const counts = tableCounts(reader.db, [...runTables, "run_turns"]);

  const schema = reader.db
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
    ].map((name) => [name, reader.db.query(`PRAGMA ${name}`).get()]),
  );

  const report = {
    scope: "root-approved-standalone-readonly-sql",
    phase,
    at: new Date().toISOString(),
    path,
    beforeHash,
    sourceHashes: beforeSources,
    integrity,
    inventory: { matched: true, ids: actual.length },
    sqlite: reader.db.query("SELECT sqlite_version() AS version").get(),
    pragmas,
    schema,
    counts,
    queries: reader.traces,
    querySummaries: reader.summary(),
    results,
    lifecycle: await lifecycle(reader.db),
    sidecarsBefore,
    limits: [
      "No SqlRunStore constructor,migrations,SQL writes or live/raw/working database access.",
      "Exact SQL shapes use source constants/projections;historical IN and current json_each run on the same immutable diagnostic copy.",
      "Native SQLite does not reproduce Workerd binding ceilings;successful native200-binding queries are not runtime parity proof.",
      "Ten warm-cache repetitions on a shared host are local diagnostics, not a controlled hardware benchmark or production p99.",
      "SQL duration excludes EXPLAIN and result hashing;operation duration includes first EXPLAIN. JSON row-to-view conversion and post-scan feed filtering are not measured.",
      "No new indexes,ANALYZE,checkpoint or persisted pragma changes were performed by this probe.",
    ],
  };

  reader.db.close();
  closed = true;
  const afterHash = await fileSha256(path);

  if (afterHash !== beforeHash) {
    throw new Error("Read-only diagnostic source hash changed.");
  }

  const afterSources = await hashSources();
  const output = artifactPath(evidence, sqlReport(phase));

  if (await Bun.file(output).exists()) {
    throw new Error("SQL evidence exists. Choose a new phase.");
  }

  atomic(output, {
    ...report,
    afterHash,
    sourceHashesAfter: afterSources,
    sourceUnchangedDuringProbe: isDeepStrictEqual(afterSources, beforeSources),
    sidecarsAfter: await readdir(dirname(path)),
  });
  process.stdout.write(`${JSON.stringify({ output, counts, results })}\n`);
} finally {
  if (!closed) {
    reader.db.close();
  }
}
