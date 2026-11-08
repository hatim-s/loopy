import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Scope } from "effect";
import { newRun } from "../../../../../packages/core/_tests_/fixtures/run";
import { qualityTestRoot } from "../../../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { fixtureScope } from "../../../../../packages/runtime/_tests_/fixtures/test-scope";
import { makeSqliteRunStore } from "../../../../../packages/runtime/src/store";
import { requireRunInventory } from "../../../dev/playground/metrics/sql-probe";
import { sqlCases } from "../../../dev/playground/metrics/sql-queries";

test("the SQL probe measures only statements the store sends", async () => {
  const file = join(qualityTestRoot("sql-probe"), "runs.sqlite");

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeSqliteRunStore(file);
      yield* store.createRun(newRun());
    }).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

  const db = new Database(file, { readonly: true });

  try {
    const cases = sqlCases(db);
    const counts = cases.filter((item) => item.sql.includes("count(*)"));

    // The store counts per definition; the old probe timed a GROUP BY status it never runs.
    expect(cases.some((item) => /GROUP BY status\b/.test(item.sql))).toBe(false);
    expect(counts.map((item) => item.operation)).toContain("counts.by-definition");
    expect(cases.find((item) => item.name === "runs.latest")?.bindings).toEqual([50]);
  } finally {
    db.close();
  }
});

test("the run inventory check sorts ids in SQLite byte order", () => {
  const db = new Database(":memory:");

  try {
    db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT)");
    db.exec("INSERT INTO runs VALUES ('a','queued'),('B','failed')");

    const census = [
      { id: "a", status: "queued" },
      { id: "B", status: "failed" },
    ];

    expect(requireRunInventory(db, census, "mismatch").map((row) => row.id)).toEqual(["B", "a"]);
  } finally {
    db.close();
  }
});
