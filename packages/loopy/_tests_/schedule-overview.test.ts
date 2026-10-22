import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../src/core/index.js";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { SCHEMA, WAIT_SCHEMA } from "../src/store/sqlite/store-schema.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind} schedule overview counts all workspaces and caps ordered summaries without input`, async () => {
    const root = mkdtempSync(join(tmpdir(), "loopy-schedule-overview-"));
    const sqlite = kind === "sqlite" ? new SqliteRunStore(join(root, "runs.sqlite")) : null;
    const store: Store = sqlite ?? new MemoryStore();
    cleanups.push(() => {
      sqlite?.close();
      rmSync(root, { recursive: true, force: true });
    });
    expect(await store.scheduleOverview()).toEqual({ workspaces: [], active: 0, next: [] });

    for (let index = 14; index >= 0; index--) {
      await store.putSchedule({
        workspace: index === 0 ? "/a" : `/b${String(index).padStart(2, "0")}`,
        slug: "shared",
        cron: "@daily",
        tz: "UTC",
        input: { privatePayload: "x".repeat(20_000) },
        enabled: index !== 0,
        nextFireAt: "2030-01-01T00:00:00.000Z",
      });
    }

    // Input parsing is forbidden on this read, even if a retained payload is unreadable.
    if (sqlite) {
      const db = new Database(join(root, "runs.sqlite"));
      db.exec("UPDATE schedules SET input_json='unreadable payload'");
      db.close();
    }

    const overview = await store.scheduleOverview();
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

for (const version of [13, 14, 15]) {
  test(`schema ${version} retains schedule payload, version, event and epoch while adding the overview index`, async () => {
    const root = mkdtempSync(join(tmpdir(), `loopy-schedule-v${version}-`));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "runs.sqlite");

    if (version === 15) {
      const store = new SqliteRunStore(file);
      store.close();
    }

    const db = new Database(file);

    if (version !== 15) {
      db.exec(version === 13 ? SCHEMA.replace(WAIT_SCHEMA, "") : SCHEMA);
    }

    db.exec("DROP INDEX IF EXISTS schedules_enabled_next");
    db.exec("INSERT OR REPLACE INTO meta VALUES ('epoch','schedule-retained')");
    db.query("INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?)").run(
      "/b",
      "shared",
      "@daily",
      "UTC",
      '{"retained":true}',
      1,
      "old-fire",
      "2030-01-01T00:00:00.000Z",
      9,
    );
    db.query("INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,?,?,?,?,?)").run(
      "2030-01-01T00:00:00.000Z",
      "schedule-retained-txn",
      "schedule",
      "deleted",
      null,
      '{"workspace":"/a","slug":"old"}',
    );
    db.exec(`PRAGMA user_version=${version}`);
    db.close();

    const store = new SqliteRunStore(file);
    expect(await store.epoch()).toBe("schedule-retained");
    expect((await store.listSchedules())[0]).toMatchObject({
      workspace: "/b",
      slug: "shared",
      version: 9,
      lastFireKey: "old-fire",
      input: { retained: true },
    });
    expect((await store.events(0, 10))[0]?.txn).toBe("schedule-retained-txn");
    expect((await store.scheduleOverview()).active).toBe(1);
    store.close();

    const persisted = new Database(file);
    expect(persisted.query("PRAGMA user_version").get()).toEqual({ user_version: 15 });

    const plans = persisted
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT workspace,slug,cron,tz,next_fire_at FROM schedules WHERE enabled=1 ORDER BY next_fire_at,workspace,slug LIMIT 10",
      )
      .all();

    expect(plans.some((plan) => plan.detail.includes("schedules_enabled_next"))).toBe(true);
    expect(plans.some((plan) => plan.detail.includes("TEMP B-TREE"))).toBe(false);
    persisted.close();
    const reopened = new SqliteRunStore(file);
    expect(await reopened.epoch()).toBe("schedule-retained");
    expect((await reopened.listSchedules())[0]?.version).toBe(9);
    reopened.close();
  });
}
