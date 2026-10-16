import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ActivationOptions,
  type LoopyContext,
  NESTED_STEP_MESSAGE,
  type StepContext,
} from "../runtime/index.js";

type Scope = { context: LoopyContext; insideStep: boolean; fail: (error: Error) => void };

const STORAGE = new AsyncLocalStorage<Scope>();

function active(): Scope {
  const scope = STORAGE.getStore();

  if (!scope) {
    throw new Error("No loopy run is active. Call step() from inside a loopy's run function.");
  }

  return scope;
}

export function current(): LoopyContext {
  return active().context;
}

export function workflowContext(): LoopyContext {
  const scope = active();

  if (scope.insideStep) {
    const error = new Error(NESTED_STEP_MESSAGE);
    scope.fail(error);
    throw error;
  }

  return scope.context;
}

function workflow<T>(fn: () => T, context: LoopyContext, fail: Scope["fail"]): T {
  return STORAGE.run({ context, insideStep: false, fail }, fn);
}

function step<T>(fn: () => T, context: StepContext): T {
  const scope = active();

  return STORAGE.run(
    { ...scope, context: { ...scope.context, log: context.log }, insideStep: true },
    fn,
  );
}

export const WRAP = { workflow, step } satisfies NonNullable<ActivationOptions["wrap"]>;
