import type { ExecutionKey, Graph, Json } from "../src/core/index.js";
import { type Effect, type EngineState, initialState, step } from "../src/engine/index.js";

export const at = "2026-10-20T00:00:00.000Z";

export const start = (graph: Graph, input: Json = {}) =>
  step(graph, initialState("run", input), { kind: "run_started", at });

export function dispatches(effects: Effect[]) {
  return effects.filter((effect) => effect.kind === "dispatch");
}

export function complete(
  graph: Graph,
  state: EngineState,
  key: ExecutionKey,
  stdout: string,
  attempt = 1,
) {
  return step(graph, state, {
    kind: "execution_completed",
    executionKey: key,
    attempt,
    at,
    result: { kind: "succeeded", output: { stdout, stderr: "", exitCode: 0 }, logs: [] },
  });
}

export function failed(graph: Graph, state: EngineState, key: ExecutionKey, attempt = 1) {
  return step(graph, state, {
    kind: "execution_failed",
    executionKey: key,
    attempt,
    at,
    error: { code: "execution", message: "broken" },
    exitCode: null,
    logs: [],
  });
}
