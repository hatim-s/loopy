import { ERROR_FIELDS } from "@loopy/core";
import { currentBuilder } from "../builder";
import type { Condition, Ref } from "../ref";
import { type AuthorValue, serialize, serializeRef } from "../ref";
import type { InferRecord, Result } from "../types";
import { validatePredicate } from "../validate";

type Arm = () => AuthorValue;

function labelled(arms: Record<string, Arm>) {
  return Object.entries(arms).map(([name, run]) => ({ name, run }));
}

export function branch<Y extends AuthorValue, N extends AuthorValue>(
  condition: Condition,
  arms: { yes: () => Y; no: () => N },
): Ref<Result<Y> | Result<N>> {
  const builder = currentBuilder();
  const predicate = condition.lower(builder);
  validatePredicate(predicate, builder);

  const { id, tails } = builder.control("branch", () => ({
    arms: [
      { name: "yes", run: arms.yes },
      { name: "no", run: arms.no },
    ],
    node: (entry) => ({ kind: "branch", predicate, arms: { yes: entry("yes"), no: entry("no") } }),
  }));

  builder.continueFrom(id, tails);

  return builder.ref(id);
}

export function switch_<A extends Record<string, Arm>>(
  on: Ref<string | number | boolean>,
  arms: A & { default: Arm },
): Ref<Result<ReturnType<A[keyof A]>>> {
  const builder = currentBuilder();
  const value = serializeRef(on, builder);
  const labels = Object.keys(arms).filter((label) => label !== "default");

  const { id, tails } = builder.control("switch", () => ({
    arms: labelled(arms),
    node: (entry) => ({
      kind: "switch",
      on: value,
      cases: Object.fromEntries(labels.map((label) => [label, entry(label)])),
      default: entry("default"),
    }),
  }));

  builder.continueFrom(id, tails);

  return builder.ref(id);
}

type Collected<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code: string } };

export function map<T, R extends AuthorValue, M extends "fail" | "collect">(
  over: Ref<T[]>,
  body: (item: Ref<T>, index: Ref<number>) => R,
  options: { concurrency?: number; onError: M },
): Ref<(M extends "collect" ? Collected<Result<R>> : Result<R>)[]> {
  const builder = currentBuilder();
  const items = serializeRef(over, builder);

  const { id, tails } = builder.control("map", (owner) => {
    const item = builder.binding(owner, "item");
    const index = builder.binding(owner, "index");

    return {
      arms: [{ name: "body", run: () => body(builder.ref(item), builder.ref(index)) }],
      node: (entry) => ({
        kind: "map",
        over: items,
        body: entry("body"),
        item,
        index,
        concurrency: options.concurrency ?? 4,
        onError: options.onError,
      }),
    };
  });

  for (const tail of tails) {
    builder.edge(tail, id, "join");
  }

  builder.continueFrom(id, [id], "next");

  return builder.ref(id);
}

export function parallel<A extends Record<string, Arm>>(
  arms: A,
): Ref<{ [K in keyof A]: Result<ReturnType<A[K]>> }, { [K in keyof A]: Result<ReturnType<A[K]>> }> {
  const builder = currentBuilder();

  const { id, tails } = builder.control("parallel", () => ({
    arms: labelled(arms),
    node: (entry) => ({
      kind: "parallel",
      branches: Object.fromEntries(Object.keys(arms).map((label) => [label, entry(label)])),
    }),
  }));

  builder.continueFrom(id, tails);

  return builder.ref(id);
}

export function finally_<R extends AuthorValue>(body: () => R, cleanup: Arm): Ref<Result<R>> {
  const builder = currentBuilder();

  const { id, tails } = builder.control("finally", () => ({
    arms: [
      { name: "body", run: body },
      { name: "cleanup", run: cleanup },
    ],
    node: (entry) => ({ kind: "finally", body: entry("body"), cleanup: entry("cleanup") }),
  }));

  builder.continueFrom(id, tails);

  return builder.ref(id);
}

export function rescue<R extends AuthorValue, H extends AuthorValue>(
  body: () => R,
  handler: (error: Ref<InferRecord<typeof ERROR_FIELDS>, InferRecord<typeof ERROR_FIELDS>>) => H,
): Ref<Result<R> | Result<H>> {
  const builder = currentBuilder();

  const { id, tails } = builder.control("rescue", (owner) => {
    const error = builder.binding(owner, "error");

    return {
      arms: [
        { name: "body", run: body },
        {
          name: "handler",
          run: () => handler(builder.ref(error, { kind: "record", fields: ERROR_FIELDS })),
        },
      ],
      node: (entry) => ({ kind: "rescue", body: entry("body"), handler: entry("handler"), error }),
    };
  });

  builder.continueFrom(id, tails);

  return builder.ref(id);
}

export function fail(message: string | Ref<string>): Ref<never> {
  const builder = currentBuilder();

  return builder.ref(builder.add({ kind: "fail", message: serialize(message, builder) }).id);
}
