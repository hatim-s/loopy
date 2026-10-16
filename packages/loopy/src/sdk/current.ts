import { AsyncLocalStorage } from "node:async_hooks";
import type { LoopyContext, StepContext } from "../runtime/index.js";

type Scope =
  | { kind: "workflow"; context: LoopyContext; fail: (error: Error) => void }
  | { kind: "step"; log: StepContext["log"]; fail: (error: Error) => void };

const SCOPE: unique symbol = Symbol.for("loopy.scope");

// SAFETY: Every SDK copy uses this process-wide symbol for the same scope storage contract.
const GLOBAL = globalThis as typeof globalThis & { [SCOPE]?: AsyncLocalStorage<Scope> };

const STORAGE = (GLOBAL[SCOPE] ??= new AsyncLocalStorage<Scope>());

export const NESTED_STEP_MESSAGE =
  "Steps cannot be nested. Call steps from the workflow function, never from inside another step.";

function active(): Scope {
  const scope = STORAGE.getStore();

  if (!scope) {
    throw new Error("No loopy run is active. Call step() from inside a loopy's run function.");
  }

  return scope;
}

export function current() {
  const scope = active();

  return scope.kind === "workflow" ? scope.context : scope;
}

export function workflowContext(): LoopyContext {
  const scope = active();

  if (scope.kind === "step") {
    const error = new Error(NESTED_STEP_MESSAGE);
    scope.fail(error);
    throw error;
  }

  return scope.context;
}

export function workflowScope<T>(
  fn: () => T,
  context: LoopyContext,
  fail: (error: Error) => void,
): T {
  return STORAGE.run({ kind: "workflow", context, fail }, fn);
}

export function stepScope<T>(fn: () => T, context: StepContext): T {
  const { fail } = active();

  return STORAGE.run({ kind: "step", log: context.log, fail }, fn);
}
