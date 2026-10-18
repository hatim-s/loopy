import { expect, test } from "bun:test";
import { graphSchema } from "../src/contract/index.js";
import { type ExecutionKey, type Json } from "../src/core/index.js";
import { initialState, step } from "../src/engine/index.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

const at = "2026-10-18T00:00:00.000Z";

function sequence() {
  const graph = structuredClone(approveDemoGraph);
  const draft = graph.nodes[0];
  const log = graph.nodes[1];

  if (draft?.kind !== "code" || log?.kind !== "log") {
    throw new Error("Approve fixture changed.");
  }

  draft.module.bundleHash = "a".repeat(64);

  return graphSchema.parse({
    ...graph,
    nodes: [
      draft,
      log,
      {
        id: "2:join",
        label: null,
        scope: null,
        kind: "join",
        result: { kind: "value", value: { ref: draft.id, path: [] } },
      },
    ],
    edges: [
      { from: draft.id, to: log.id, kind: "next" },
      { from: log.id, to: "2:join", kind: "next" },
    ],
    outputs: { ref: "2:join", path: [] },
  });
}

function start() {
  const graph = sequence();

  const transition = step(graph, initialState("run", { subject: "Engine" }), {
    kind: "run_started",
    at,
  });

  const dispatch = transition.effects.find((effect) => effect.kind === "dispatch");

  if (dispatch?.kind !== "dispatch") {
    throw new Error("Expected code dispatch.");
  }

  return { graph, ...transition, dispatch };
}

function completed(executionKey: ExecutionKey, attempt: number, output: Json) {
  return {
    kind: "execution_completed" as const,
    executionKey,
    attempt,
    at,
    result: { kind: "succeeded" as const, output, logs: [] },
  };
}

test("approve sequence prefix dispatches resolved code, records log and final join", () => {
  const f = start();
  expect(f.dispatch.spec).toMatchObject({ kind: "code", input: { subject: "Engine" } });
  const result = step(f.graph, f.state, completed(f.dispatch.executionKey, 1, { words: 42 }));
  expect(result.state.phase).toEqual({
    kind: "finished",
    outcome: { status: "succeeded", output: { words: 42 } },
  });
  expect(
    result.state.nodeRuns.map((node) => [String(node.key.nodeId), node.key.scope, node.status]),
  ).toEqual([
    ["0:draft", [], "succeeded"],
    ["1:log", [], "succeeded"],
    ["2:join", [], "succeeded"],
  ]);
  expect(result.effects).toContainEqual(
    expect.objectContaining({
      kind: "emit_event",
      event: expect.objectContaining({ entity: "log" }),
    }),
  );
  expect(f.state.nodeRuns[0]?.status).toBe("running");
  expect(step(f.graph, f.state, completed(f.dispatch.executionKey, 1, { words: 42 }))).toEqual(
    result,
  );
});

test("retry backoff persists the deadline, does not dispatch early, increments the same key", () => {
  const f = start();

  const failed = step(f.graph, f.state, {
    kind: "execution_failed",
    executionKey: f.dispatch.executionKey,
    attempt: 1,
    error: { code: "execution", message: "Temporary failure." },
    exitCode: null,
    at,
  });

  expect(failed.state.nodeRuns[0]).toMatchObject({
    status: "retrying",
    attempt: 1,
    nextRetryAt: "2026-10-18T00:00:01.000Z",
  });
  expect(
    step(f.graph, failed.state, { kind: "retry_due", at }).effects.some(
      (effect) => effect.kind === "dispatch",
    ),
  ).toBe(false);

  const retried = step(f.graph, failed.state, {
    kind: "retry_due",
    at: "2026-10-18T00:00:01.000Z",
  });

  expect(retried.effects).toContainEqual(
    expect.objectContaining({
      kind: "dispatch",
      executionKey: f.dispatch.executionKey,
      attempt: 2,
    }),
  );
  expect(step(f.graph, retried.state, completed(f.dispatch.executionKey, 1, { words: 1 }))).toEqual(
    { state: retried.state, effects: [] },
  );
});

const invalidOutputs: Json[] = [{ words: "invalid" }, { words: 2, text: "x".repeat(1024 * 1024) }];

test.each(invalidOutputs)("invalid or oversized output fails without retries", (output) => {
  const f = start();
  const result = step(f.graph, f.state, completed(f.dispatch.executionKey, 1, output));
  expect(result.state.phase).toMatchObject({ kind: "finished", outcome: { status: "failed" } });
  expect(result.effects.some((effect) => effect.kind === "schedule_retry")).toBe(false);
});

test("resume from completed node runs skips code and reconstructs final output", () => {
  const f = start();
  const done = step(f.graph, f.state, completed(f.dispatch.executionKey, 1, { words: 3 }));
  const state = initialState("run", { subject: "Engine" }, done.state.nodeRuns.slice(0, 1));
  const resumed = step(f.graph, state, { kind: "run_started", at });
  expect(resumed.effects.some((effect) => effect.kind === "dispatch")).toBe(false);
  expect(resumed.state.phase).toMatchObject({
    kind: "finished",
    outcome: { output: { words: 3 } },
  });
});

test("resume redispatches a running execution with its persisted attempt", () => {
  const f = start();
  expect(
    step(f.graph, initialState("run", { subject: "Engine" }, f.state.nodeRuns), {
      kind: "run_started",
      at,
    }).effects,
  ).toContainEqual(f.dispatch);
});

test("a missing input reference fails its consuming node before dispatch", () => {
  const result = step(sequence(), initialState("run", {}), { kind: "run_started", at });
  expect(result.state.nodeRuns).toMatchObject([
    {
      status: "failed",
      error: { code: "validation", message: expect.stringContaining("completed output") },
    },
  ]);
  expect(result.effects.some((effect) => effect.kind === "dispatch")).toBe(false);
});
