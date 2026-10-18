import { isRecord, isRef, type Json, projectValue, type Value } from "../core/index.js";
import { type EngineState, nodeRunFor } from "./state.js";

export function resolve(value: Value, state: EngineState): Json | undefined {
  if (Array.isArray(value)) {
    const result: Json[] = [];

    for (const item of value) {
      const resolved = resolve(item, state);

      if (resolved === undefined) {
        return undefined;
      }

      result.push(resolved);
    }

    return result;
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isRef(value)) {
    const run = nodeRunFor(state, value.ref);

    return projectValue(
      value.ref === "input" ? state.input : run?.status === "succeeded" ? run.output : undefined,
      value.path,
    );
  }

  return resolveValues(value, state);
}

export function resolveValues(
  values: Record<string, Value>,
  state: EngineState,
): Record<string, Json> | undefined {
  const entries: [string, Json][] = [];

  for (const [key, value] of Object.entries(values)) {
    const resolved = resolve(value, state);

    if (resolved === undefined) {
      return undefined;
    }

    entries.push([key, resolved]);
  }

  return Object.fromEntries(entries);
}
