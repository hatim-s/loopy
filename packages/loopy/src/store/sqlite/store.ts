import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqlRunStore } from "../portable.js";
import { BunSqlDriver } from "./bun-driver.js";
import { localOwnerPolicy } from "./local-owner.js";
import { initializeLocalSchema } from "./local-schema.js";

export class SqliteRunStore extends SqlRunStore {
  constructor(file: string, now: () => number = Date.now, options: { leaseMs?: number } = {}) {
    const db = new BunSqlDriver(file);

    try {
      initializeLocalSchema(db);
      super(db, { ...options, now, owner: localOwnerPolicy() });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  dataVersion(): number {
    return (
      this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0
    );
  }
}

export function openRunStore(home: string, options: { leaseMs?: number } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });

  return new SqliteRunStore(join(home, "runs.sqlite"), Date.now, options);
}
