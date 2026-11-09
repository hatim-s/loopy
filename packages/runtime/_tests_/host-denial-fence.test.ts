import { expect, test } from "bun:test";
import { loopy, sh } from "@loopy/sdk/graph";
import { Effect } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { activateDurable } from "../src/host";
import { PolicyProvider } from "./fixtures/host-policy";
import { memoryStore } from "./fixtures/stores";

test("an admission denial reloads state and cannot overwrite a newer persisted attempt", async () => {
  const store = memoryStore();
  const provider = new PolicyProvider();

  const graph = loopy("limited", {
    input: {},
    run: () => sh(["true"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
  });

  const at = newRun().createdAt;
  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.acquireRateLimit("shared", 1, 60_000, at));
  provider.lookup = (key) => {
    return Effect.gen(function* () {
      const previous = yield* store.getNodeRun(key);

      if (!previous) {
        throw new Error("Expected committed attempt.");
      }

      yield* store.apply({
        runId: "run",
        token: "owner",
        effects: [{ kind: "write_node_run", nodeRun: { ...previous, attempt: 2 } }],
      });

      return { kind: "none" as const };
    }).pipe(Effect.orDie);
  };

  expect(
    await Effect.runPromise(
      activateDurable({
        store,
        provider,
        graph,
        runId: "run",
        token: "owner",
        at,
        maxWork: 32,
        pollMs: 1000,
      }),
    ),
  ).toMatchObject({ status: "pending" });
  expect(await Effect.runPromise(store.getNodeRuns("run"))).toMatchObject([
    { status: "running", attempt: 2 },
  ]);
  expect(provider.starts).toEqual([]);
  expect(await Effect.runPromise(store.getLogs("run"))).toEqual([]);
});
