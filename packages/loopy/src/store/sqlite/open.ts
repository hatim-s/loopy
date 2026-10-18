import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homePaths } from "../../executor/index.js";
import { SqliteRunStore } from "./store.js";
import { SCHEMA, SCHEMA_VERSION } from "./store-schema.js";

export function openDatabase(file: string) {
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  db.transaction(() => {
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;

    if (version === SCHEMA_VERSION) {
      return;
    }

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();

    // Defer foreign keys until every old table has been dropped.
    db.exec("PRAGMA defer_foreign_keys=ON");

    for (const table of tables) {
      db.exec(`DROP TABLE "${table.name.replaceAll('"', '""')}"`);
    }

    db.exec(SCHEMA);
    db.query("INSERT INTO meta VALUES ('epoch',?)").run(crypto.randomUUID());
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  }).immediate();

  return db;
}

export function openRunStore(home: string, options: { leaseMs?: number } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });

  return new SqliteRunStore(homePaths(home).runsDb, Date.now, options);
}
