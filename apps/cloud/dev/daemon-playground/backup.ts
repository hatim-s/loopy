import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeBoundary, type RunView, runStatusSchema } from "@loopy/contract";
import { readDaemonFile } from "@loopy/runtime/local";
import { Schema } from "effect";
import { byId } from "../playground/metrics/sql-probe";
import { createOnce } from "../shared/fs";
import { closedDatabase } from "./closed-executions";
import { home } from "./config";
import { PLANNED_RUNS } from "./plan";

const decodeRows = decodeBoundary(
  Schema.Array(Schema.Struct({ id: Schema.String, status: runStatusSchema })),
);

const decodeJournal = decodeBoundary(Schema.Struct({ journal_mode: Schema.String }));

const decodeIntegrity = decodeBoundary(Schema.Struct({ integrity_check: Schema.String }));

function rows(database: Database) {
  return decodeRows(database.query("SELECT id,status FROM runs ORDER BY id").all());
}

function sidecars(path: string) {
  return ["-wal", "-shm", "-journal"].flatMap((suffix) =>
    existsSync(path + suffix) ? [{ suffix, bytes: statSync(path + suffix).size }] : [],
  );
}

function withDatabase<T>(path: string, readonly: boolean, read: (database: Database) => T) {
  const database = new Database(path, { readonly });

  try {
    return read(database);
  } finally {
    database.close();
  }
}

// The daemon must be stopped, so a read-only open sees a settled database and serialize copies it.
export async function backupClosedDatabase(apiRuns: Pick<RunView, "id" | "status">[] | null) {
  if (readDaemonFile(home)) {
    throw new Error("Refusing a diagnostic backup while the isolated daemon is alive.");
  }

  const source = join(home, "runs.sqlite");
  const destination = closedDatabase;
  const sidecarsBefore = sidecars(source);

  const original = withDatabase(source, true, (database) => ({
    rows: rows(database),
    bytes: database.serialize(),
  }));

  createOnce(
    destination,
    original.bytes,
    0o600,
    `Closed database backup ${destination} already exists. Move it aside to back up again.`,
  );

  const destinationJournal = withDatabase(
    destination,
    false,
    (database) => decodeJournal(database.query("PRAGMA journal_mode=DELETE").get()).journal_mode,
  );

  const copied = withDatabase(destination, true, (database) => ({
    integrity: decodeIntegrity(database.query("PRAGMA integrity_check").get()).integrity_check,
    rows: rows(database),
  }));

  const matchesApi =
    apiRuns === null ? null : isDeepStrictEqual(copied.rows, [...apiRuns].sort(byId));

  return {
    method: "bun:sqlite serialize from read-only source after owned daemon exit",
    source,
    destination,
    destinationJournal,
    sidecarsBefore,
    sidecarsAfter: sidecars(source),
    sourceRows: original.rows,
    copiedRows: copied.rows,
    integrity: copied.integrity,
    matchesSource: isDeepStrictEqual(original.rows, copied.rows),
    matchesApi,
    matchesAllPlannedApiRuns: copied.rows.length === PLANNED_RUNS && matchesApi === true,
  };
}
