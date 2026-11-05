import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { MemoryStore, makeSqliteRunStore } from "../src/store/index.js";
import { checkCountHistory } from "./fixtures/readmodel-assertions.js";
import { readmodelDirectory } from "./fixtures/readmodel-directory.js";
import { countHistory, readmodelAt } from "./fixtures/readmodel-history.js";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

for (const memory of [false, true]) {
  test(`${memory ? "memory" : "sqlite"} grouped counts match filtered authoritative runs through transitions and rollback`, async () => {
    const directory = readmodelDirectory();
    const scope = Effect.runSync(Scope.make());
    cleanups.push(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    const file = join(directory, "runs.sqlite");

    const sqlite = memory
      ? null
      : await Effect.runPromise(
          makeSqliteRunStore(file, () => Date.parse(readmodelAt)).pipe(
            Effect.provideService(Scope.Scope, scope),
          ),
        );

    const store = sqlite ?? new MemoryStore(() => Date.parse(readmodelAt));

    checkCountHistory(
      await countHistory(store),
      "Invalid store timestamp 'invalid-timestamp'. Validate timestamps before persistence.",
    );

    if (!sqlite) {
      const rows = await Effect.runPromise(store.runCountsByDefinition());
      const row = rows[0];

      if (!row) {
        throw new Error("Missing synthetic count row.");
      }

      row.count = 999;
      expect(await Effect.runPromise(store.runCountsByDefinition())).not.toEqual(rows);

      return;
    }

    const db = new Database(file, { readonly: true });

    const schema = db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type,name,sql FROM sqlite_schema ORDER BY name",
      )
      .all();

    const records = await Effect.runPromise(sqlite.listRuns());
    const cursor = await Effect.runPromise(sqlite.eventCursor());
    const rows = await Effect.runPromise(sqlite.runCountsByDefinition());
    await Effect.runPromise(sqlite.close());

    const reopened = await Effect.runPromise(
      makeSqliteRunStore(file, () => Date.parse(readmodelAt)).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    try {
      expect(await Effect.runPromise(reopened.runCountsByDefinition())).toEqual(rows);
      expect(await Effect.runPromise(reopened.listRuns())).toEqual(records);
      expect(await Effect.runPromise(reopened.eventCursor())).toEqual(cursor);
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
      await Effect.runPromise(reopened.close());
      db.close();
    }
  });
}
