import {
  type ExecutionKey,
  executionKeyString,
  isRecord,
  isRef,
  type Json,
  projectValue,
  type Ref,
  type Value,
} from "../core/index.js";
import type { EngineState } from "./state.js";

export type ResolutionContext = {
  scope: ExecutionKey["scope"];
  bindings: ReadonlyMap<string, Json>;
};

export const ROOT_CONTEXT: ResolutionContext = { scope: [], bindings: new Map() };

export function reference(
  value: Ref,
  state: EngineState,
  context: ResolutionContext,
): Json | undefined {
  if (value.ref === "input") {
    return projectValue(state.input, value.path);
  }

  if (context.bindings.has(value.ref)) {
    return projectValue(context.bindings.get(value.ref), value.path);
  }

  for (let length = context.scope.length; length >= 0; length--) {
    const scope = context.scope.slice(0, length);

    const run = state.nodeRuns.find(
      (run) =>
        String(run.key.nodeId) === value.ref &&
        run.key.runId === state.runId &&
        run.key.scope.length === scope.length &&
        scope.every(
          (part, index) =>
            run.key.scope[index]?.nodeId === part.nodeId &&
            run.key.scope[index]?.index === part.index,
        ),
    );

    if (run?.status === "succeeded") {
      return projectValue(run.output, value.path);
    }
  }

  return undefined;
}

export function resolve(value: Value, state: EngineState, context = ROOT_CONTEXT): Json {
  if (Array.isArray(value)) {
    return value.map((item) => resolve(item, state, context));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isRef(value)) {
    const output = reference(value, state, context);

    if (output === undefined) {
      throw new Error(
        `Reference '${[value.ref, ...value.path].join(".")}' has no completed output.`,
      );
    }

    return output;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolve(item, state, context)]),
  );
}

export function resolveValues(
  values: Record<string, Value>,
  state: EngineState,
  context = ROOT_CONTEXT,
) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, resolve(value, state, context)]),
  );
}

export function sameExecution(left: ExecutionKey, right: ExecutionKey) {
  return executionKeyString(left) === executionKeyString(right);
}
