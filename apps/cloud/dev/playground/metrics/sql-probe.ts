import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "../../shared/hash";

// Read-only probes shared by the cloud diagnostic copy and the stopped daemon backup.

export const runTables = [
  "runs",
  "node_runs",
  "node_attempts",
  "node_scopes",
  "logs",
  "events",
  "waits",
] as const;

export async function fileSha256(path: string) {
  return sha256Hex(await readFile(path));
}

export function requireRunInventory(
  db: Database,
  expected: readonly { id: string; status: string }[],
  message: string,
) {
  const actual = db
    .query<{ id: string; status: string }, []>("SELECT id,status FROM runs ORDER BY id")
    .all();

  const sorted = expected
    .map(({ id, status }) => ({ id, status }))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (!isDeepStrictEqual(actual, sorted)) {
    throw new Error(message);
  }

  return actual;
}

export function tableCounts(db: Database, tables: readonly string[]) {
  return tables.map((table) => ({
    table,
    rows:
      db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0,
  }));
}
