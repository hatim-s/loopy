import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { checkScopePages } from "./fixtures/readmodel-assertions.js";
import { readmodelDirectory } from "./fixtures/readmodel-directory.js";
import { seedScopes } from "./fixtures/readmodel-scopes.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

for (const memory of [false, true]) {
  test(`${memory ? "memory" : "sqlite"} scope items preserve membership, counts and cursors`, async () => {
    const directory = readmodelDirectory();
    const sqlite = memory ? null : new SqliteRunStore(join(directory, "runs.sqlite"));
    const store = sqlite ?? new MemoryStore();
    cleanups.push(() => {
      sqlite?.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await seedScopes(store);
    await checkScopePages((query) => store.scopeItems("scope-run", query));
    expect(
      await store.scopeItems("absent", { nodeId: "map", parentScope: "[]", limit: 200 }),
    ).toEqual({ items: [], next: null });
  });
}
