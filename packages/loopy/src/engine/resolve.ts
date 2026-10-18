import { executionKeyString, isRecord, type Json, type Ref, type Value } from "../core/index.js";
import type { EngineState } from "./state.js";

function isRef(value: Value): value is Ref {
  return isRecord(value) && "ref" in value;
}

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

    let output =
      value.ref === "input" ? state.input : run?.status === "succeeded" ? run.output : undefined;

    for (const field of value.path) {
      output = isRecord(output) ? output[String(field)] : undefined;
    }

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

export function sameExecution(
  left: Parameters<typeof executionKeyString>[0],
  right: Parameters<typeof executionKeyString>[0],
) {
  return executionKeyString(left) === executionKeyString(right);
}
