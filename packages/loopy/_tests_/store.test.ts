import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";
import { storeContract } from "./store-contract.js";

const stores: SqliteRunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

storeContract("sqlite", (options) => {
  const store = new SqliteRunStore(":memory:", options?.now, options);
  stores.push(store);

  return store;
});

test("schema 15 resets old journal tables and rotates epoch, then survives reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-schema15-"));
  const file = join(root, "runs.sqlite");

  try {
    const old = new Database(file);
    old.exec(
      "CREATE TABLE steps(seq INTEGER); CREATE TABLE hooks(token TEXT); PRAGMA user_version=12",
    );
    old.close();
    const store = new SqliteRunStore(file);
    const epoch = await store.epoch();
    await store.createRun(newRun());
    store.close();
    const db = new Database(file);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 15 });

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);

    expect(tables).toContain("node_runs");
    expect(tables).not.toContain("hooks");
    expect(tables).not.toContain("steps");
    db.close();
    const reopened = new SqliteRunStore(file);
    expect(await reopened.getRun("run")).toEqual(newRun());
    expect(await reopened.epoch()).toBe(epoch);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
