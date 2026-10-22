import { expect, test } from "bun:test";
import { nodeRunSchema } from "../src/contract/index.js";
import { type Graph, type Json, outputBytes } from "../src/core/index.js";
import { type EngineState, initialState, step } from "../src/engine/index.js";
import { code, loopy, map, sh } from "../src/sdk/graph/index.js";
import { at, dispatches, failed, start } from "./engine-control-fixture.js";
import { approveDemoGraph } from "./fixtures/graphs.js";

function codeGraph(): Graph {
  const graph = structuredClone(approveDemoGraph);
  const node = graph.nodes[0];

  if (node?.kind !== "code") {
    throw new Error("Expected code fixture.");
  }

  node.module.bundleHash = "a".repeat(64);
  graph.nodes = [node];
  graph.edges = [];
  graph.outputs = null;

  return graph;
}

function succeed(graph: Graph, state: EngineState, attempt = 1) {
  const run = state.nodeRuns[0];

  if (!run) {
    throw new Error("Expected captured execution.");
  }

  return step(graph, state, {
    kind: "execution_completed",
    executionKey: run.key,
    attempt,
    at,
    result: { kind: "succeeded", output: { words: 1 }, logs: [] },
  });
}

test("code records resolved inputs before dispatch and keeps its own snapshot", () => {
  const graph = codeGraph();
  const input = { subject: { nested: ["first"] }, unused: "not passed to code" };
  const result = start(graph, input);
  const [dispatch] = dispatches(result.effects);
  const recorded = result.state.nodeRuns[0];

  if (!recorded || dispatch?.spec.kind !== "code") {
    throw new Error("Expected captured code dispatch.");
  }

  expect(dispatch?.spec).toMatchObject({ kind: "code", input: { subject: input.subject } });
  expect(recorded?.inputView).toEqual({ state: "available", value: { subject: input.subject } });
  expect(nodeRunSchema.parse(recorded).inputView).toEqual(recorded?.inputView);
  expect(result.effects[0]).toEqual({ kind: "write_node_run", nodeRun: recorded });
  expect(result.effects[1]).toBe(dispatch);

  dispatch.spec.input.subject = "executor mutation";
  expect(recorded?.inputView).toEqual({ state: "available", value: { subject: input.subject } });
  const done = succeed(graph, result.state);
  expect(done.state.nodeRuns[0]).toMatchObject({
    status: "succeeded",
    receipt: "finished",
    inputView: recorded?.inputView,
  });
  expect(dispatches(done.effects)).toEqual([]);
});

test("map iterations capture their own resolved item and index", () => {
  const graph = loopy("iteration-input", {
    input: { items: "string[]" },
    run: ({ input }) =>
      map(
        input.get("items"),
        (item, index) =>
          code("item", {
            in: { item, index },
            out: { kind: "value", type: "string" },
            module: "./item.ts",
          }),
        { concurrency: 2, onError: "fail" },
      ),
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  const result = start(graph, { items: ["first", "second"] });
  expect(dispatches(result.effects).map((dispatch) => dispatch.spec)).toMatchObject([
    { input: { item: "first", index: 0 } },
    { input: { item: "second", index: 1 } },
  ]);
  expect(
    result.state.nodeRuns.map((run) => ({
      scope: run.key.scope.map((part) => part.index),
      inputView: run.inputView,
    })),
  ).toEqual([
    { scope: [0], inputView: { state: "available", value: { item: "first", index: 0 } } },
    { scope: [1], inputView: { state: "available", value: { item: "second", index: 1 } } },
  ]);
});

test("each retry captures the actual resolved input and retains failure metadata", () => {
  const graph = codeGraph();
  const first = start(graph, { subject: "first" });
  const [dispatch] = dispatches(first.effects);

  if (!dispatch) {
    throw new Error("Expected code dispatch.");
  }

  const retrying = failed(graph, first.state, dispatch.executionKey);
  expect(retrying.state.nodeRuns[0]?.inputView).toEqual({
    state: "available",
    value: { subject: "first" },
  });

  const retried = step(
    graph,
    { ...retrying.state, input: { subject: "second" } },
    {
      kind: "retry_due",
      at: "2026-10-20T00:00:01.000Z",
    },
  );

  expect(dispatches(retried.effects)[0]?.spec).toMatchObject({ input: { subject: "second" } });
  expect(retried.state.nodeRuns[0]).toMatchObject({
    attempt: 2,
    inputView: { state: "available", value: { subject: "second" } },
  });
  expect(succeed(graph, retried.state, 2).state.nodeRuns[0]?.inputView).toEqual(
    retried.state.nodeRuns[0]?.inputView,
  );

  const terminal = step(graph, retried.state, {
    kind: "execution_failed",
    executionKey: dispatch.executionKey,
    attempt: 2,
    at,
    error: { code: "uncertain", message: "Unfinished receipt." },
    exitCode: null,
    logs: [],
  });

  expect(terminal.state.nodeRuns[0]).toMatchObject({
    status: "failed",
    inputView: retried.state.nodeRuns[0]?.inputView,
  });
});

test("input cap counts UTF-8 JSON bytes and stores no partial value above 16 KiB", () => {
  const graph = codeGraph();
  const boundary = { subject: "x".repeat(16 * 1024 - outputBytes({ subject: "" })) };
  expect(outputBytes(boundary)).toBe(16 * 1024);
  expect(start(graph, boundary).state.nodeRuns[0]?.inputView).toEqual({
    state: "available",
    value: boundary,
  });

  const oversized = { subject: `${boundary.subject}💥` };
  const captured = start(graph, oversized);
  expect(captured.state.nodeRuns[0]?.inputView).toEqual({
    state: "truncated",
    bytes: 16 * 1024 + 4,
  });
  expect(dispatches(captured.effects)[0]?.spec).toMatchObject({ input: oversized });
  expect(succeed(graph, captured.state).state.nodeRuns[0]?.inputView).toEqual({
    state: "truncated",
    bytes: outputBytes(oversized),
  });
});

test("redispatch and rate-limit admission preserve metadata and historical omission", () => {
  const graph = codeGraph();
  const first = start(graph, { subject: "saved" });
  const [dispatch] = dispatches(first.effects);
  expect(first.state.nodeRuns[0]?.inputView).toEqual({
    state: "available",
    value: { subject: "saved" },
  });

  if (!dispatch) {
    throw new Error("Expected code dispatch.");
  }

  const resumed = step(graph, initialState("run", { subject: "saved" }, first.state.nodeRuns), {
    kind: "run_started",
    at,
  });

  expect(resumed.state.nodeRuns[0]?.inputView).toEqual(first.state.nodeRuns[0]?.inputView);
  expect(dispatches(resumed.effects)).toEqual([dispatch]);
  const retryAt = "2026-10-20T00:00:01.000Z";

  const limited = step(graph, first.state, {
    kind: "rate_limited",
    executionKey: dispatch.executionKey,
    attempt: 1,
    retryAt,
    at,
  });

  expect(limited.state.nodeRuns[0]?.inputView).toEqual(first.state.nodeRuns[0]?.inputView);
  const due = step(graph, limited.state, { kind: "retry_due", at: retryAt });
  expect(due.state.nodeRuns[0]).toMatchObject({
    attempt: 1,
    inputView: first.state.nodeRuns[0]?.inputView,
  });

  const historical = structuredClone(first.state.nodeRuns);

  for (const run of historical) {
    delete run.inputView;
  }

  const old = step(graph, initialState("run", { subject: "saved" }, historical), {
    kind: "run_started",
    at,
  });

  expect(old.state.nodeRuns[0]).not.toHaveProperty("inputView");
  expect(dispatches(old.effects)).toEqual([dispatch]);
});

test("cancel and pre-dispatch validation failures retain the previous attempt input", () => {
  const graph = codeGraph();
  const first = start(graph, { subject: "saved" });
  expect(first.state.nodeRuns[0]?.inputView).toEqual({
    state: "available",
    value: { subject: "saved" },
  });

  const cancelled = step(graph, first.state, { kind: "cancel_requested", at });
  expect(cancelled.state.nodeRuns[0]).toMatchObject({
    status: "cancelled",
    inputView: first.state.nodeRuns[0]?.inputView,
  });

  const invalid = step(graph, initialState("run", {}, first.state.nodeRuns), {
    kind: "run_started",
    at,
  });

  expect(invalid.state.nodeRuns[0]).toMatchObject({
    status: "failed",
    inputView: first.state.nodeRuns[0]?.inputView,
  });
  expect(dispatches(invalid.effects)).toEqual([]);
});

test("capture excludes command environment and runtime-declared secrets", () => {
  const secret = "synthetic-secret-marker";

  const graph = loopy("command-input", {
    input: {},
    run: () => sh(["echo", secret], { env: { PRIVATE_TOKEN: secret }, stdin: secret }),
  }).graph;

  graph.meta.secrets = ["PRIVATE_TOKEN"];
  const command = start(graph);
  expect(dispatches(command.effects)[0]?.spec).toMatchObject({ env: { PRIVATE_TOKEN: secret } });
  expect(command.state.nodeRuns[0]).not.toHaveProperty("inputView");
  expect(JSON.stringify(command.state.nodeRuns)).not.toContain(secret);

  const code = codeGraph();
  code.meta.secrets = ["PRIVATE_TOKEN"];
  const input: Json = { subject: "safe", PRIVATE_TOKEN: secret };
  const recorded = start(code, input);
  expect(recorded.state.nodeRuns[0]?.inputView).toEqual({
    state: "available",
    value: { subject: "safe" },
  });
  expect(JSON.stringify(recorded.state.nodeRuns)).not.toContain(secret);
});

test("code capture never reads process environment", () => {
  const key = "LOOPY_CAPTURE_TEST_PRIVATE_TOKEN";
  const previous = process.env[key];
  process.env[key] = "synthetic-os-environment-secret";

  try {
    const graph = codeGraph();
    graph.meta.secrets = [key];
    const result = start(graph, { subject: "safe" });
    expect(result.state.nodeRuns[0]?.inputView).toEqual({
      state: "available",
      value: { subject: "safe" },
    });
    expect(JSON.stringify(result.state.nodeRuns)).not.toContain("synthetic-os-environment-secret");
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});
