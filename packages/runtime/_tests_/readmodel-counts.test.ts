import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Scope } from "effect";
import { makeSqliteRunStore } from "../src/store";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { checkCountHistory } from "./fixtures/readmodel-assertions";
import { countHistory, readmodelAt } from "./fixtures/readmodel-history";
import { fixtureScope } from "./fixtures/test-scope";

test("grouped counts match filtered authoritative runs through transitions and rollback", async () => {
  const directory = qualityTestRoot("readmodel");
  const file = join(directory, "runs.sqlite");

  const sqlite = await Effect.runPromise(
    makeSqliteRunStore(file).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

  checkCountHistory(
    await countHistory(sqlite),
    "Invalid store timestamp 'invalid-timestamp'. Validate timestamps before persistence.",
  );

  const db = new Database(file, { readonly: true });

  const schema = db
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type,name,sql FROM sqlite_schema ORDER BY name",
    )
    .all();

  const records = await Effect.runPromise(sqlite.queryRuns({ limit: 200, now: readmodelAt }));
  const cursor = await Effect.runPromise(sqlite.eventCursor());
  const rows = await Effect.runPromise(sqlite.runCountsByDefinition());
  await Effect.runPromise(sqlite.close());

  const reopened = await Effect.runPromise(
    makeSqliteRunStore(file).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

  try {
    expect(await Effect.runPromise(reopened.runCountsByDefinition())).toEqual(rows);
    expect(await Effect.runPromise(reopened.queryRuns({ limit: 200, now: readmodelAt }))).toEqual(
      records,
    );
    expect(await Effect.runPromise(reopened.eventCursor())).toEqual(cursor);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(db.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: "16",
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
