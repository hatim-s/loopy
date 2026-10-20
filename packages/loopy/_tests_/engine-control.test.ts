import { expect, test } from "bun:test";
import { initialState, step } from "../src/engine/index.js";
import {
  and,
  branch,
  exists,
  fail,
  finally_,
  format,
  gt,
  in_,
  loopy,
  map,
  now,
  parallel,
  random,
  rescue,
  sh,
  size,
  sleep,
  switch_,
  uuid,
  wait,
} from "../src/sdk/graph/index.js";
import { at, complete, dispatches, failed, start } from "./engine-control-fixture.js";

test("branch and switch run only selected arms and resolve joined nested values", () => {
  const graph = loopy("selected", {
    input: { pick: "string", values: "string[]" },
    run: ({ input }) => {
      const chosen = branch(
        and(
          exists(input.get("pick")),
          gt(size(input.get("values")), 0),
          in_(input.get("pick"), ["yes"]),
        ),
        {
          yes: () =>
            switch_(input.get("pick"), {
              yes: () => ({ nested: { value: format("{pick}!", { pick: input.get("pick") }) } }),
              default: () => fail("wrong default"),
            }),
          no: () => fail("wrong branch"),
        },
      );

      return { chosen, nested: [chosen] };
    },
  }).graph;

  const result = start(graph, { pick: "yes", values: ["x"] });
  expect(result.state.phase).toEqual({
    kind: "finished",
    outcome: {
      status: "succeeded",
      output: { chosen: { nested: { value: "yes!" } }, nested: [{ nested: { value: "yes!" } }] },
    },
  });
  expect(
    result.state.nodeRuns.some(
      (run) => graph.nodes.find((node) => node.id === run.key.nodeId)?.kind === "fail",
    ),
  ).toBe(false);
});

test("nested maps persist ordered scopes and reconstruct item/index and ancestor refs", () => {
  const graph = loopy("nested-map", {
    input: { outer: "string[]", inner: "string[]" },
    run: ({ input }) =>
      map(
        input.get("outer"),
        (outer, index) => {
          const prefix = format("{index}:{outer}", { index, outer });

          return map(
            input.get("inner"),
            (inner, innerIndex) =>
              sh([format("{prefix}/{innerIndex}:{inner}", { prefix, innerIndex, inner })]).get(
                "stdout",
              ),
            { concurrency: 1, onError: "fail" },
          );
        },
        { concurrency: 1, onError: "fail" },
      ),
  }).graph;

  let result = start(graph, { outer: ["a", "b"], inner: ["x", "y"] });

  for (const text of ["0:a/0:x", "0:a/1:y", "1:b/0:x", "1:b/1:y"]) {
    const dispatch = dispatches(result.effects)[0];
    expect(dispatch?.spec).toMatchObject({ argv: [text] });

    if (!dispatch) {
      throw new Error("Missing map dispatch");
    }

    expect(dispatch.executionKey.scope).toHaveLength(2);

    const rehydrated = step(
      graph,
      initialState("run", { outer: ["a", "b"], inner: ["x", "y"] }, result.state.nodeRuns),
      { kind: "run_started", at },
    );

    expect(dispatches(rehydrated.effects)).toEqual([dispatch]);
    result = complete(graph, rehydrated.state, dispatch.executionKey, text);
  }

  expect(result.state.phase).toMatchObject({
    kind: "finished",
    outcome: {
      output: [
        ["0:a/0:x", "0:a/1:y"],
        ["1:b/0:x", "1:b/1:y"],
      ],
    },
  });
  expect(
    result.state.nodeRuns.filter(
      (run) =>
        run.key.scope.length === 2 &&
        graph.nodes.find((node) => node.id === run.key.nodeId)?.kind === "command",
    ),
  ).toHaveLength(4);
});

test("map bounds concurrency, fences scoped retries and collects failures in input order", () => {
  const graph = loopy("collect", {
    input: { items: "string[]" },
    run: ({ input }) =>
      map(input.get("items"), (item) => sh([item], { retry: { attempts: 2 } }).get("stdout"), {
        concurrency: 2,
        onError: "collect",
      }),
  }).graph;

  const first = start(graph, { items: ["a", "b", "c"] });
  const [a, b] = dispatches(first.effects);

  if (!a || !b) {
    throw new Error("Missing initial map dispatches");
  }

  expect(dispatches(first.effects)).toHaveLength(2);
  const retry = failed(graph, first.state, b.executionKey);
  expect(dispatches(retry.effects)).toHaveLength(0);
  const doneA = complete(graph, retry.state, a.executionKey, "a");
  const c = dispatches(doneA.effects)[0];

  if (!c) {
    throw new Error("Missing replacement map dispatch");
  }

  expect(c.spec).toMatchObject({ argv: ["c"] });
  const doneC = complete(graph, doneA.state, c.executionKey, "c");
  const due = step(graph, doneC.state, { kind: "retry_due", at: "2026-10-20T00:00:01.000Z" });
  expect(dispatches(due.effects)).toMatchObject([{ executionKey: b.executionKey, attempt: 2 }]);
  expect(complete(graph, due.state, b.executionKey, "stale", 1).effects).toEqual([]);
  const result = failed(graph, due.state, b.executionKey, 2);
  expect(result.state.phase).toMatchObject({
    kind: "finished",
    outcome: {
      output: [
        { ok: true, value: "a" },
        { ok: false, error: { message: "broken", code: "execution" } },
        { ok: true, value: "c" },
      ],
    },
  });
});

test("parallel joins out of order completions without dispatching running siblings twice", () => {
  const graph = loopy("parallel", {
    input: {},
    run: () =>
      parallel({
        left: () => sh(["left"]).get("stdout"),
        right: () => sh(["right"]).get("stdout"),
      }),
  }).graph;

  const first = start(graph);
  const [left, right] = dispatches(first.effects);

  if (!left || !right) {
    throw new Error("Missing parallel dispatches");
  }

  const doneRight = complete(graph, first.state, right.executionKey, "R");
  expect(dispatches(doneRight.effects)).toHaveLength(0);
  const done = complete(graph, doneRight.state, left.executionKey, "L");
  expect(done.state.phase).toMatchObject({
    kind: "finished",
    outcome: { output: { left: "L", right: "R" } },
  });
});

test("finally persists cleanup once and rescue retains failed child diagnostics", () => {
  const graph = loopy("unwind", {
    input: {},
    run: () =>
      rescue(
        () =>
          finally_(
            () => sh(["body"], { retry: { attempts: 1 } }),
            () => sh(["cleanup"]),
          ),
        (error) =>
          format("caught:{code}:{message}", {
            code: error.get("code"),
            message: error.get("message"),
          }),
      ),
  }).graph;

  const first = start(graph);
  const body = dispatches(first.effects)[0];

  if (!body) {
    throw new Error("Missing body dispatch");
  }

  const failure = failed(graph, first.state, body.executionKey);
  const cleanup = dispatches(failure.effects)[0];
  expect(cleanup?.spec).toMatchObject({ argv: ["cleanup"] });

  if (!cleanup) {
    throw new Error("Missing cleanup dispatch");
  }

  const resumed = step(graph, initialState("run", {}, failure.state.nodeRuns), {
    kind: "run_started",
    at,
  });

  expect(dispatches(resumed.effects)).toEqual([cleanup]);
  const result = complete(graph, resumed.state, cleanup.executionKey, "clean");
  expect(result.state.phase).toMatchObject({
    kind: "finished",
    outcome: { status: "succeeded", output: "caught:execution:broken" },
  });
  expect(result.state.nodeRuns.filter((run) => run.status === "failed")).toHaveLength(2);
});

test("sleep and wait persist deadlines, scoped identity, and resume without duplicate registration", () => {
  const graph = loopy("waits", {
    input: { items: "string[]" },
    run: ({ input }) =>
      map(
        input.get("items"),
        () => {
          sleep("1s");

          return wait("approve", { timeout: "2s", payload: { kind: "value", type: "boolean" } });
        },
        { concurrency: 2, onError: "collect" },
      ),
  }).graph;

  const first = start(graph, { items: ["a", "b"] });
  expect(first.effects).toContainEqual({
    kind: "suspend_run",
    wakeAt: "2026-10-20T00:00:01.000Z",
    at,
  });

  const second = step(graph, initialState("run", { items: ["a", "b"] }, first.state.nodeRuns), {
    kind: "run_started",
    at: "2026-10-20T00:00:01.000Z",
  });

  const registrations = second.effects.filter((effect) => effect.kind === "register_wait");
  expect(registrations).toHaveLength(2);
  expect(
    new Set(registrations.map((effect) => JSON.stringify(effect.executionKey.scope))).size,
  ).toBe(2);

  const resumed = step(graph, initialState("run", { items: ["a", "b"] }, second.state.nodeRuns), {
    kind: "run_started",
    at: "2026-10-20T00:00:02.000Z",
  });

  expect(resumed.effects.some((effect) => effect.kind === "register_wait")).toBe(false);
  const expired = step(graph, resumed.state, { kind: "retry_due", at: "2026-10-20T00:00:03.000Z" });
  expect(expired.state.phase).toMatchObject({
    kind: "finished",
    outcome: { status: "succeeded", output: [{ ok: false }, { ok: false }] },
  });
});

test("entropy is supplied by host and persisted values survive rehydration", () => {
  const graph = loopy("values", {
    input: {},
    run: () => parallel({ time: now, id: uuid, value: random }),
  }).graph;

  let result = start(graph);
  const samples = result.effects.filter((effect) => effect.kind === "sample");
  expect(samples).toHaveLength(2);

  for (const sample of samples) {
    result = step(graph, result.state, {
      kind: "value_sampled",
      executionKey: sample.executionKey,
      value: sample.valueKind === "uuid" ? "12345678-1234-4123-8123-123456789abc" : 0.25,
      at: "2026-10-20T00:00:10.000Z",
    });
  }

  const rehydrated = step(graph, initialState("run", {}, result.state.nodeRuns), {
    kind: "run_started",
    at: "2026-10-21T00:00:00.000Z",
  });

  expect(rehydrated.effects.some((effect) => effect.kind === "sample")).toBe(false);
  expect(rehydrated.state.phase).toMatchObject({
    kind: "finished",
    outcome: { output: { time: at, id: "12345678-1234-4123-8123-123456789abc", value: 0.25 } },
  });
});

test("command argv expands string arrays while preserving spaces within each argument", () => {
  const graph = loopy("argv", {
    input: { paths: "string[]" },
    run: ({ input }) => sh(["import", input.get("paths"), "--last"]),
  }).graph;

  expect(dispatches(start(graph, { paths: ["a b", "c,d", ""] }).effects)[0]?.spec).toMatchObject({
    argv: ["import", "a b", "c,d", "", "--last"],
  });
  expect(dispatches(start(graph, { paths: [] }).effects)[0]?.spec).toMatchObject({
    argv: ["import", "--last"],
  });
  expect(start(graph, { paths: ["a", 2] }).state.phase).toMatchObject({
    kind: "finished",
    outcome: { status: "failed", error: "Command argument arrays must contain only strings." },
  });
});
