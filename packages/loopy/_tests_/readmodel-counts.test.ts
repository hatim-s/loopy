import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { checkCountHistory } from "./fixtures/readmodel-assertions.js";
import { readmodelDirectory } from "./fixtures/readmodel-directory.js";
import { countHistory, readmodelAt } from "./fixtures/readmodel-history.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

for (const memory of [false, true]) {
  test(`${memory ? "memory" : "sqlite"} grouped counts match filtered authoritative runs through transitions and rollback`, async () => {
    const directory = readmodelDirectory();
    const file = join(directory, "runs.sqlite");
    const sqlite = memory ? null : new SqliteRunStore(file, () => Date.parse(readmodelAt));
    const store = sqlite ?? new MemoryStore(() => Date.parse(readmodelAt));
    cleanups.push(() => {
      sqlite?.close();
      rmSync(directory, { recursive: true, force: true });
    });
    checkCountHistory(await countHistory(store), "Invalid Date");

    if (!sqlite) {
      const rows = await store.runCountsByDefinition();
      const row = rows[0];

      if (!row) {
        throw new Error("Missing synthetic count row.");
      }

      row.count = 999;
      expect(await store.runCountsByDefinition()).not.toEqual(rows);

      return;
    }

    const db = new Database(file, { readonly: true });

    const schema = db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type,name,sql FROM sqlite_schema ORDER BY name",
      )
      .all();

    const records = await sqlite.listRuns();
    const cursor = await sqlite.eventCursor();
    const rows = await sqlite.runCountsByDefinition();
    sqlite.close();
    const reopened = new SqliteRunStore(file, () => Date.parse(readmodelAt));

    try {
      expect(await reopened.runCountsByDefinition()).toEqual(rows);
      expect(await reopened.listRuns()).toEqual(records);
      expect(await reopened.eventCursor()).toEqual(cursor);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 15 });
      expect(db.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
        value: "15",
      });
      expect(
        db
          .query<{ type: string; name: string; sql: string | null }, []>(
            "SELECT type,name,sql FROM sqlite_schema ORDER BY name",
          )
          .all(),
      ).toEqual(schema);
      expect(schema.filter((row) => row.type === "trigger")).toEqual([]);
    } finally {
      reopened.close();
      db.close();
    }
  });
}
