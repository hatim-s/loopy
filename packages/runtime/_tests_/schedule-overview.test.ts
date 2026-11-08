import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Scope } from "effect";
import { makeSqliteRunStore } from "../src/store";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { memoryStore } from "./fixtures/stores";
import { fixtureScope } from "./fixtures/test-scope";

for (const kind of ["portable", "local"] as const) {
  test(`${kind} schedule overview counts all workspaces and caps ordered summaries without input`, async () => {
    const root = qualityTestRoot("schedule-overview");

    const sqlite =
      kind === "local"
        ? await Effect.runPromise(
            makeSqliteRunStore(join(root, "runs.sqlite")).pipe(
              Effect.provideService(Scope.Scope, fixtureScope()),
            ),
          )
        : null;

    const store = sqlite ?? memoryStore();
    expect(await Effect.runPromise(store.scheduleOverview())).toEqual({
      workspaces: [],
      active: 0,
      next: [],
    });

    for (let index = 14; index >= 0; index--) {
      await Effect.runPromise(
        store.putSchedule({
          workspace: index === 0 ? "/a" : `/b${String(index).padStart(2, "0")}`,
          slug: "shared",
          cron: "@daily",
          tz: "UTC",
          input: { privatePayload: "x".repeat(20_000) },
          enabled: index !== 0,
          nextFireAt: "2030-01-01T00:00:00.000Z",
        }),
      );
    }

    // Input parsing is forbidden on this read, even if a retained payload is unreadable.
    if (sqlite) {
      const db = new Database(join(root, "runs.sqlite"));
      db.exec("UPDATE schedules SET input_json='unreadable payload'");
      db.close();
    }

    const overview = await Effect.runPromise(store.scheduleOverview());
    expect(overview.workspaces).toEqual([
      "/a",
      ...[...Array(14).keys()].map((index) => `/b${String(index + 1).padStart(2, "0")}`),
    ]);
    expect(overview.active).toBe(14);
    expect(overview.next.map((row) => row.workspace)).toEqual(
      [...Array(10).keys()].map((index) => `/b${String(index + 1).padStart(2, "0")}`),
    );
    expect(overview.next[0]).toEqual({
      workspace: "/b01",
      slug: "shared",
      cron: "@daily",
      tz: "UTC",
      nextFireAt: "2030-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(overview)).not.toContain("privatePayload");
  });
}
