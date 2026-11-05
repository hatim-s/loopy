import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { MemoryStore, makeSqliteRunStore } from "../src/store/index.js";
import { checkScopePages } from "./fixtures/readmodel-assertions.js";
import { readmodelDirectory } from "./fixtures/readmodel-directory.js";
import { seedScopes } from "./fixtures/readmodel-scopes.js";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

for (const memory of [false, true]) {
  test(`${memory ? "memory" : "sqlite"} scope items preserve membership, counts and cursors`, async () => {
    const directory = readmodelDirectory();
    const scope = Effect.runSync(Scope.make());
    cleanups.push(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));

    const sqlite = memory
      ? null
      : await Effect.runPromise(
          makeSqliteRunStore(join(directory, "runs.sqlite")).pipe(
            Effect.provideService(Scope.Scope, scope),
          ),
        );

    const store = sqlite ?? new MemoryStore();

    await seedScopes(store);
    await checkScopePages((query) => Effect.runPromise(store.scopeItems("scope-run", query)));
    expect(
      await Effect.runPromise(
        store.scopeItems("absent", { nodeId: "map", parentScope: "[]", limit: 200 }),
      ),
    ).toEqual({ items: [], next: null });
  });
}
