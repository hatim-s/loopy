import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** Creates a local home database exactly as schema 13 or 14 left it. The caller seeds and closes it. */
export function legacyDatabase(file: string, version: 13 | 14): Database {
  const db = new Database(file);
  db.exec(readFileSync(new URL(`./schema-${version}.sql`, import.meta.url), "utf8"));
  db.exec(`PRAGMA user_version=${version}`);

  return db;
}
