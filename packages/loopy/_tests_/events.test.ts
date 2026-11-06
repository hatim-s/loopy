import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  decodeBoundary,
  nodeIdSchema,
  runView,
  serverEvent,
  serverEventSchema,
} from "../src/contract";
import { MemoryStore } from "../src/store";
import { newRun } from "./fixture";

test("node and run outbox events publish one isolated transaction and parse over SSE", async () => {
  const store = new MemoryStore();
  const batches: string[][] = [];
  store.subscribe((events) => {
    batches.push(events.map((event) => event.entity));
    events.splice(0);
  });
  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));
  await Effect.runPromise(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        {
          kind: "write_node_run",
          nodeRun: {
            key: { runId: "run", nodeId: decodeBoundary(nodeIdSchema)("0:join"), scope: [] },
            attempt: 1,
            maxAttempts: 1,
            startedAt: newRun().createdAt,
            endedAt: newRun().createdAt,
            status: "succeeded",
            output: null,
            receipt: "none",
          },
        },
        {
          kind: "finish_run",
          outcome: { status: "succeeded", output: null },
          at: newRun().createdAt,
        },
      ],
    }),
  );
  expect(batches.at(-1)).toEqual(["node", "run"]);

  for (const event of await Effect.runPromise(store.events(0, 100))) {
    const wire = serverEvent(event, (run) =>
      runView({
        run,
        steps: [],
        hooks: [],
        loopy: { slug: run.slug, description: null },
        now: run.updatedAt,
        leaseMs: store.leaseMs,
      }),
    );

    expect(decodeBoundary(serverEventSchema)(wire)).toEqual(wire);
  }
});
