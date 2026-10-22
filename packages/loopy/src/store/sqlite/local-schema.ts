import type { SqlDriver } from "./driver.js";
import { applyQuerySchema } from "./query-schema.js";
import { createSqlSchema, markSqlSchema } from "./schema.js";
import { SCHEDULE_OVERVIEW_INDEX, SCHEMA_VERSION, WAIT_SCHEMA } from "./store-schema.js";

export function initializeLocalSchema(db: SqlDriver): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  db.transaction(() => {
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;

    if (version === SCHEMA_VERSION) {
      db.exec(SCHEDULE_OVERVIEW_INDEX);
      markSqlSchema(db);

      return;
    }

    if (version === 13 || version === 14) {
      if (version === 13) {
        db.exec(WAIT_SCHEMA);
      }

      applyQuerySchema(db);
      db.exec(SCHEDULE_OVERVIEW_INDEX);
      markSqlSchema(db);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);

      return;
    }

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();

    if (tables.length > 0 || version !== 0) {
      throw new Error(
        `Database schema ${version} cannot be opened by this runtime. Preserve this home and migrate its saved definitions into a separate home.`,
      );
    }

    createSqlSchema(db);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  }, "immediate");
}
