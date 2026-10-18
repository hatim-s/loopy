import { isRecord, isRef, type Json, projectValue, type Value } from "../core/index.js";
import type { EngineState } from "./state.js";

export function resolve(value: Value, state: EngineState): Json {
  if (Array.isArray(value)) {
    return value.map((item) => resolve(item, state));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isRef(value)) {
    const run = state.nodeRuns.find(
      (run) => String(run.key.nodeId) === value.ref && run.key.scope.length === 0,
    );

    const output = projectValue(
      value.ref === "input" ? state.input : run?.status === "succeeded" ? run.output : undefined,
      value.path,
    );

    if (output === undefined) {
      throw new Error(
        `Reference '${[value.ref, ...value.path].join(".")}' has no completed output.`,
      );
    }

    return output;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolve(item, state)]),
  );
}

export function resolveValues(values: Record<string, Value>, state: EngineState) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, resolve(value, state)]),
  );
}
