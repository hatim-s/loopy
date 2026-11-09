import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Scope } from "effect";
import { makeSqliteRunStore } from "../src/store";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { checkScopePages } from "./fixtures/readmodel-assertions";
import { seedScopes } from "./fixtures/readmodel-scopes";
import { fixtureScope } from "./fixtures/test-scope";

test("scope items preserve membership, counts and cursors", async () => {
  const directory = qualityTestRoot("readmodel");

  const store = await Effect.runPromise(
    makeSqliteRunStore(join(directory, "runs.sqlite")).pipe(
      Effect.provideService(Scope.Scope, fixtureScope()),
    ),
  );

  await seedScopes(store);
  await checkScopePages((query) => Effect.runPromise(store.scopeItems("scope-run", query)));
  expect(
    await Effect.runPromise(
      store.scopeItems("absent", { nodeId: "map", parentScope: "[]", limit: 200 }),
    ),
  ).toEqual({ items: [], next: null });
});
