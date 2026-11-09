import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { BunSqlDriver } from "../../../src/store/bun-driver";
import { upgradeLegacyHome } from "../../../src/store/schema/legacy";

/** Creates a local home database exactly as schema 13 or 14 left it. The caller seeds and closes it. */
export function legacyDatabase(file: string, version: 13 | 14): Database {
  const db = new Database(file);
  db.exec(readFileSync(new URL(`./schema-${version}.sql`, import.meta.url), "utf8"));
  db.exec(`PRAGMA user_version=${version}`);

  return db;
}

/**
 * Creates a store exactly as schema 15 left it, with the version in the meta marker. Schema 15
 * was schema 14 plus the frozen local step, so this replays that step. The caller seeds and closes it.
 */
export function schema15Database(file: string): Database {
  legacyDatabase(file, 14).close();
  const driver = new BunSqlDriver(file);
  upgradeLegacyHome(driver);
  driver.close();

  return new Database(file);
}
