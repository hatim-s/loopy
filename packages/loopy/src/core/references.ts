import type { Reference, ReferenceSource } from "./model.js";

type Refs<T> = { readonly [K in keyof T]: Reference<T[K]> };

/** Typed handles to run input and earlier step outputs, handed to authoring callbacks. */
export type WorkflowContext<Input, Steps> = {
  readonly input: Refs<Input>;
  readonly steps: { readonly [K in keyof Steps]: Refs<Steps[K]> };
};

export function reference<T>(source: ReferenceSource, path: string[]): Reference<T> {
  return { $ref: { source, path } };
}

/** Lazily builds references: `input.x` is one level deep, `steps.id.field` is two. */
function referenceTree<T>(source: ReferenceSource, path: string[] = []): T {
  return new Proxy(Object.create(null) as T & object, {
    get(_target, key) {
      if (typeof key !== "string") {
        return undefined;
      }
      const next = [...path, key];
      if (source === "steps" && path.length === 0) {
        return referenceTree(source, next);
      }
      return reference(source, next);
    },
  });
}

export function context<Input, Steps>(): WorkflowContext<Input, Steps> {
  return { input: referenceTree("input"), steps: referenceTree("steps") };
}

export function at<Item>(source: Reference<readonly Item[]>, index: number): Reference<Item>;
export function at<T, Key extends keyof T & string>(
  source: Reference<T>,
  key: Key,
): Reference<T[Key]>;
export function at(source: Reference<unknown>, key: string | number): Reference<unknown> {
  if (typeof key === "number" && (!Number.isSafeInteger(key) || key < 0)) {
    throw new Error("An array reference index must be a nonnegative integer.");
  }
  return reference(source.$ref.source, [...source.$ref.path, String(key)]);
}
