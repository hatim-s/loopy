import { expect, test } from "bun:test";
import {
  decodeBoundary,
  nodeIdSchema,
  runView,
  serverEvent,
  serverEventSchema,
} from "@loopy/contract";
import { Effect } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { memoryStore } from "./fixtures/stores";

test("stored run and node events parse over SSE", async () => {
  const store = memoryStore();
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

  for (const event of await Effect.runPromise(store.events(0, 100))) {
    const wire = serverEvent(event, (run) =>
      runView({
        run,
        hook: undefined,
        ownerStale: false,
      }),
    );

    expect(decodeBoundary(serverEventSchema)(wire)).toEqual(wire);
  }
});
