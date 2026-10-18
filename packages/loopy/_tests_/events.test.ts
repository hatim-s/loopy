import { expect, test } from "bun:test";
import { nodeIdSchema, runView, serverEvent, serverEventSchema } from "../src/contract/index.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";

test("node and run outbox events publish one isolated transaction and parse over SSE", async () => {
  const store = new MemoryStore();
  const batches: string[][] = [];
  store.subscribe((events) => {
    batches.push(events.map((event) => event.entity));
    events.splice(0);
  });
  await store.createRun(newRun());
  await store.claim("run", "owner");
  await store.apply({
    runId: "run",
    token: "owner",
    effects: [
      {
        kind: "write_node_run",
        nodeRun: {
          key: { runId: "run", nodeId: nodeIdSchema.parse("0:join"), scope: [] },
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
  });
  expect(batches.at(-1)).toEqual(["node", "run"]);

  for (const event of await store.events(0, 100)) {
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

    expect(serverEventSchema.parse(wire)).toEqual(wire);
  }
});
