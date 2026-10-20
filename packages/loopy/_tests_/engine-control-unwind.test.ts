import { expect, test } from "bun:test";
import { initialState, step } from "../src/engine/index.js";
import {
  fail,
  finally_,
  log,
  loopy,
  map,
  parallel,
  rescue,
  sh,
  sleep,
  wait,
} from "../src/sdk/graph/index.js";
import { at, complete, dispatches, failed, start } from "./engine-control-fixture.js";

test("map failure settles started item cleanup before outer cleanup and never starts later items", () => {
  const graph = loopy("settle", {
    input: { items: "string[]" },
    run: ({ input }) =>
      finally_(
        () =>
          map(
            input.get("items"),
            (item) =>
              finally_(
                () => sh([item], { retry: { attempts: 1 } }),
                () => sh(["item-cleanup"]),
              ),
            { concurrency: 2, onError: "fail" },
          ),
        () => sh(["outer-cleanup"]),
      ),
  }).graph;

  const first = start(graph, { items: ["a", "b", "never"] });
  const [a, b] = dispatches(first.effects);

  if (!a || !b) {
    throw new Error("Missing item dispatches");
  }

  let result = failed(graph, first.state, a.executionKey);
  const aCleanup = dispatches(result.effects)[0];
  expect(aCleanup?.spec).toMatchObject({ argv: ["item-cleanup"] });

  if (!aCleanup) {
    throw new Error("Missing failed item cleanup");
  }

  result = complete(graph, result.state, aCleanup.executionKey, "clean");
  expect(result.state.phase.kind).toBe("active");
  expect(dispatches(result.effects)).toHaveLength(0);
  result = complete(graph, result.state, b.executionKey, "b");
  const bCleanup = dispatches(result.effects)[0];
  expect(bCleanup?.spec).toMatchObject({ argv: ["item-cleanup"] });

  if (!bCleanup) {
    throw new Error("Missing sibling item cleanup");
  }

  result = complete(graph, result.state, bCleanup.executionKey, "clean");
  const outer = dispatches(result.effects)[0];
  expect(outer?.spec).toMatchObject({ argv: ["outer-cleanup"] });

  if (!outer) {
    throw new Error("Missing outer cleanup");
  }

  result = complete(graph, result.state, outer.executionKey, "clean");
  expect(result.state.phase).toMatchObject({
    kind: "finished",
    outcome: { status: "failed", error: "broken" },
  });
  expect(result.state.nodeRuns.some((run) => run.key.scope.some((part) => part.index === 2))).toBe(
    false,
  );
});

test("suspended map cancellation unwinds each started item and survives cleanup rehydration", () => {
  const graph = loopy("cancel", {
    input: { items: "string[]" },
    run: ({ input }) =>
      finally_(
        () =>
          map(
            input.get("items"),
            () =>
              finally_(
                () => wait("approval", { payload: { kind: "value", type: "boolean" } }),
                () => log("item-cleanup"),
              ),
            { concurrency: 2, onError: "fail" },
          ),
        () => sh(["outer-cleanup"]),
      ),
  }).graph;

  const first = start(graph, { items: ["a", "b", "never"] });
  const cancelled = step(graph, first.state, { kind: "cancel_requested", at });
  const cleanup = dispatches(cancelled.effects)[0];
  expect(cleanup?.spec).toMatchObject({ argv: ["outer-cleanup"] });
  expect(cancelled.effects.filter((effect) => effect.kind === "write_log")).toHaveLength(2);
  expect(cancelled.state.nodeRuns.filter((run) => run.status === "waiting")).toHaveLength(0);

  if (!cleanup) {
    throw new Error("Missing cancellation cleanup");
  }

  const resumed = step(
    graph,
    initialState("run", { items: ["a", "b", "never"] }, cancelled.state.nodeRuns),
    { kind: "run_started", at },
  );

  expect(dispatches(resumed.effects)).toEqual([cleanup]);
  expect(resumed.effects.filter((effect) => effect.kind === "write_log")).toHaveLength(0);
  const done = complete(graph, resumed.state, cleanup.executionKey, "clean");
  expect(done.state.phase).toEqual({ kind: "finished", outcome: { status: "cancelled" } });
});

test("cleanup failure takes precedence and rescue catches failures from immediate nodes", () => {
  const graph = loopy("cleanup-failure", {
    input: {},
    run: () =>
      rescue(
        () =>
          finally_(
            () => fail("body failed"),
            () => fail("cleanup failed"),
          ),
        (error) => error.get("message"),
      ),
  }).graph;

  const result = start(graph);
  expect(result.state.phase).toMatchObject({
    kind: "finished",
    outcome: { status: "succeeded", output: "cleanup failed" },
  });
  expect(
    result.state.nodeRuns.filter((run) => run.status === "failed").map((run) => run.error.message),
  ).toContain("body failed");
});

test("a retry and an indefinite wait suspend until the retry deadline", () => {
  const graph = loopy("retry-wait", {
    input: {},
    run: () =>
      parallel({
        execution: () => sh(["retry"]),
        approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
      }),
  }).graph;

  const first = start(graph);
  const dispatch = dispatches(first.effects)[0];

  if (!dispatch) {
    throw new Error("Missing retry dispatch");
  }

  const result = failed(graph, first.state, dispatch.executionKey);
  expect(result.effects).toContainEqual({
    kind: "suspend_run",
    wakeAt: "2026-10-20T00:00:01.000Z",
    at,
  });

  const resumed = step(graph, initialState("run", {}, result.state.nodeRuns), {
    kind: "run_started",
    at: "2026-10-20T00:00:01.000Z",
  });

  expect(dispatches(resumed.effects)).toMatchObject([
    { executionKey: dispatch.executionKey, attempt: 2 },
  ]);
  expect(resumed.effects.some((effect) => effect.kind === "suspend_run")).toBe(false);
});

test("sleep deadline advances its parallel branch while an executable sibling remains running", () => {
  const graph = loopy("timed-parallel", {
    input: {},
    run: () =>
      parallel({
        work: () => sh(["long-running"]).get("stdout"),
        timer: () => {
          sleep("1s");
          log("awake");

          return "awake";
        },
      }),
  }).graph;

  const first = start(graph);
  const dispatch = dispatches(first.effects)[0];

  if (!dispatch) {
    throw new Error("Missing executable sibling");
  }

  expect(first.effects).toContainEqual({ kind: "schedule_retry", at: "2026-10-20T00:00:01.000Z" });
  expect(first.effects.some((effect) => effect.kind === "suspend_run")).toBe(false);

  const wake = step(graph, first.state, { kind: "retry_due", at: "2026-10-20T00:00:01.000Z" });

  expect(dispatches(wake.effects)).toHaveLength(0);
  expect(wake.effects.filter((effect) => effect.kind === "write_log")).toMatchObject([
    { log: { message: "awake" } },
  ]);
  expect(wake.state.phase.kind).toBe("active");

  const result = complete(graph, wake.state, dispatch.executionKey, "done");

  expect(result.state.phase).toMatchObject({
    kind: "finished",
    outcome: { output: { work: "done", timer: "awake" } },
  });
});
