import { expect, test } from "bun:test";
import { graphSchema } from "../src/contract/index.js";
import { type ExecutionKey, type ExecutionResult, type Json } from "../src/core/index.js";
import { type EngineEvent, initialState, step } from "../src/engine/index.js";
import { defineCommand, loopy, sh } from "../src/sdk/index.js";
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
    kind: "resume",
    at,
  });

  const dispatch = transition.next;

  if (dispatch?.kind !== "dispatch") {
    throw new Error("Expected code dispatch.");
  }

  return { graph, ...transition, dispatch };
}

function completed(
  executionKey: ExecutionKey,
  attempt: number,
  output: Json,
): Extract<EngineEvent, { kind: "execution_finished" }> {
  return {
    kind: "execution_finished" as const,
    executionKey,
    attempt,
    at,
    result: { kind: "succeeded" as const, output, logs: [] } satisfies ExecutionResult,
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
  expect(result.writes).toContainEqual(
    expect.objectContaining({
      kind: "write_log",
      log: expect.objectContaining({ message: "Draft ready" }),
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
    kind: "execution_finished",
    executionKey: f.dispatch.executionKey,
    attempt: 1,
    at,
    result: {
      kind: "failed",
      error: { code: "execution", message: "Temporary failure." },
      exitCode: null,
      logs: [],
    },
  });

  expect(failed.state.nodeRuns[0]).toMatchObject({
    status: "retrying",
    attempt: 1,
    nextRetryAt: "2026-10-18T00:00:01.000Z",
  });
  expect(step(f.graph, failed.state, { kind: "resume", at }).next.kind).toBe("wait");

  const retried = step(f.graph, failed.state, {
    kind: "resume",
    at: "2026-10-18T00:00:01.000Z",
  });

  expect(retried.next).toEqual(
    expect.objectContaining({
      kind: "dispatch",
      executionKey: f.dispatch.executionKey,
      attempt: 2,
    }),
  );
  expect(step(f.graph, retried.state, completed(f.dispatch.executionKey, 1, { words: 1 }))).toEqual(
    { state: retried.state, writes: [], next: retried.next },
  );
});

const invalidOutputs: Json[] = [{ words: "invalid" }, { words: 2, text: "x".repeat(1024 * 1024) }];

test.each(invalidOutputs)("invalid or oversized output fails without retries", (output) => {
  const f = start();
  const result = step(f.graph, f.state, completed(f.dispatch.executionKey, 1, output));
  expect(result.state.phase).toMatchObject({ kind: "finished", outcome: { status: "failed" } });
  expect(result.next.kind).toBe("finished");
});

test("resume from completed node runs skips code and reconstructs final output", () => {
  const f = start();
  const done = step(f.graph, f.state, completed(f.dispatch.executionKey, 1, { words: 3 }));
  const state = initialState("run", { subject: "Engine" }, done.state.nodeRuns.slice(0, 1));
  const resumed = step(f.graph, state, { kind: "resume", at });
  expect(resumed.next.kind).toBe("finished");
  expect(resumed.state.phase).toMatchObject({
    kind: "finished",
    outcome: { output: { words: 3 } },
  });
});

test("resume redispatches a running execution with its persisted attempt", () => {
  const f = start();
  expect(
    step(f.graph, initialState("run", { subject: "Engine" }, f.state.nodeRuns), {
      kind: "resume",
      at,
    }).next,
  ).toEqual(f.dispatch);
});

test("a missing input reference fails its consuming node before dispatch", () => {
  const result = step(sequence(), initialState("run", {}), { kind: "resume", at });
  expect(result.state.nodeRuns).toMatchObject([
    {
      status: "failed",
      error: { code: "validation", message: expect.stringContaining("completed output") },
    },
  ]);
  expect(result.next.kind).toBe("finished");
});

test("rate denial fences stale decisions and reserves the same attempt until the deadline", () => {
  const f = start();

  const event = {
    kind: "rate_limited" as const,
    executionKey: f.dispatch.executionKey,
    attempt: 1,
    retryAt: "2026-10-18T00:01:00.000Z",
    at,
  };

  const limited = step(f.graph, f.state, event);
  expect(limited.state.nodeRuns[0]).toMatchObject({
    status: "rate_limited",
    attempt: 1,
    nextRetryAt: event.retryAt,
  });
  expect(limited.next).toEqual({ kind: "wait", at: event.retryAt });
  expect(step(f.graph, limited.state, { kind: "resume", at }).next).toEqual({
    kind: "wait",
    at: event.retryAt,
  });
  const due = step(f.graph, limited.state, { kind: "resume", at: event.retryAt });
  expect(due.next).toEqual(f.dispatch);
  expect(step(f.graph, due.state, { ...event, attempt: 2 }).writes).toEqual([]);
});

test("stale completions emit no logs", () => {
  const f = start();
  const event = completed(f.dispatch.executionKey, 2, { words: 42 });
  event.result.logs.push({ message: "attempt", data: { count: 1 } });
  expect(step(f.graph, f.state, event).writes).toEqual([]);
});

for (const retryOnExit of [false, true]) {
  test(`command exit retry policy honors retryOnExit=${retryOnExit}`, () => {
    const graph = loopy("exit-policy", {
      input: {},
      run: () => sh(["false"], { retry: { attempts: 3, retryOnExit } }),
    }).graph;

    const started = step(graph, initialState("run", {}), { kind: "resume", at });
    const dispatch = started.next;

    if (dispatch?.kind !== "dispatch") {
      throw new Error("Expected command dispatch");
    }

    const failed = step(graph, started.state, {
      kind: "execution_finished",
      executionKey: dispatch.executionKey,
      attempt: 1,
      at,
      result: {
        kind: "failed",
        error: { code: "exit", message: "Command exited with code 2" },
        exitCode: 2,
        logs: [],
      },
    });

    expect(failed.state.nodeRuns[0]?.status).toBe(retryOnExit ? "retrying" : "failed");
    expect(failed.next.kind).toBe(retryOnExit ? "wait" : "finished");
  });
}

test("graph retry delay caps at sixty seconds across repeated failures", () => {
  const f = start();
  const node = f.graph.nodes[0];

  if (node?.kind !== "code") {
    throw new Error("Expected code fixture");
  }

  node.retry.attempts = 10;
  let state = f.state;
  let time = Date.parse(at);

  const delays: number[] = [];

  for (let attempt = 1; attempt < 10; attempt++) {
    const failed = step(f.graph, state, {
      kind: "execution_finished",
      executionKey: f.dispatch.executionKey,
      attempt,
      at: new Date(time).toISOString(),
      result: {
        kind: "failed",
        error: { code: "execution", message: "retry" },
        exitCode: null,
        logs: [],
      },
    });

    const retry = failed.next;

    if (retry.kind !== "wait") {
      throw new Error("Expected retry deadline");
    }

    const delay = Date.parse(retry.at) - time;
    delays.push(delay);

    time = Date.parse(retry.at);
    const resumed = step(f.graph, failed.state, { kind: "resume", at: retry.at });
    expect(resumed.next).toEqual(
      expect.objectContaining({ kind: "dispatch", attempt: attempt + 1 }),
    );
    state = resumed.state;
  }

  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test("a missing graph node throws instead of becoming a failed run", () => {
  const graph = sequence();
  graph.nodes = [];
  expect(() => step(graph, initialState("run", {}), { kind: "resume", at })).toThrow("is missing");
});

test("resolved command flags fail validation before dispatch", () => {
  const graph = loopy("flags", { input: { mode: "string" }, run: () => sh(["tool"]) }).graph;
  const node = graph.nodes[0];

  if (node?.kind !== "command") {
    throw new Error("Expected command node.");
  }

  node.flags = { mode: { ref: "input", path: ["mode"] } };
  node.flagSpec = {
    path: [],
    flags: { mode: { cli: "--mode", kind: "string", choices: ["safe"] } },
    style: "space",
    positionalSeparator: false,
    flagsAfterPositionals: false,
  };
  const transition = step(graph, initialState("run", { mode: "unknown" }), { kind: "resume", at });
  expect(transition.next.kind).toBe("finished");
  expect(transition.state.nodeRuns[0]).toMatchObject({
    status: "failed",
    error: { code: "validation" },
  });
});

test("a command without an output declaration completes with null", () => {
  const command = defineCommand({ key: "silent", program: "true" });
  const graph = loopy("silent", { input: {}, run: () => command() }).graph;
  const started = step(graph, initialState("run", {}), { kind: "resume", at });

  if (started.next.kind !== "dispatch") {
    throw new Error("Expected command dispatch.");
  }

  const finished = step(
    graph,
    started.state,
    completed(started.next.executionKey, 1, { stdout: "text", stderr: "", exitCode: 0 }),
  );

  expect(finished.state.phase).toEqual({
    kind: "finished",
    outcome: { status: "succeeded", output: null },
  });
  expect(finished.state.nodeRuns[0]).toMatchObject({ status: "succeeded", output: null });
});
