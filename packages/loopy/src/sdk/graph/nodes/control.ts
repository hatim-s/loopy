import { ERROR_FIELDS, type Predicate } from "../../../core/index.js";
import { currentBuilder } from "../builder.js";
import { recordPredicate } from "../predicates.js";
import type { Ref } from "../ref.js";
import { type AuthorValue, serialize, serializeRef } from "../ref.js";
import type { InferRecord, Result } from "../types.js";
import { validateLabel } from "../validate.js";

type Arm = () => AuthorValue;

export function branch<Y extends AuthorValue, N extends AuthorValue>(
  predicate: Predicate,
  arms: { yes: () => Y; no: () => N },
): Ref<Result<Y> | Result<N>> {
  const builder = currentBuilder();
  const base = builder.allocate("branch", null);

  // Install the control before expanding callbacks so nested nodes keep call-order identity.
  const node = {
    ...base,
    kind: "branch" as const,
    predicate: recordPredicate(predicate),
    arms: { yes: base.id, no: base.id },
  };

  builder.record(node);
  const yes = builder.arm(base.id, arms.yes);
  const no = builder.arm(base.id, arms.no);
  node.arms = { yes: yes.entry, no: no.entry };
  builder.continueFrom(base.id, [...yes.tails, ...no.tails]);

  return builder.ref(base.id);
}

export function switch_<A extends Record<string, Arm>>(
  on: Ref<string | number | boolean>,
  arms: A & { default: Arm },
): Ref<Result<ReturnType<A[keyof A]>>> {
  const builder = currentBuilder();
  const base = builder.allocate("switch", null);

  const node = {
    ...base,
    kind: "switch" as const,
    on: serializeRef(on, builder),
    cases: {},
    default: base.id,
  };

  builder.record(node);
  const tails = [];
  const entries = [];

  for (const [label, callback] of Object.entries(arms)) {
    validateLabel(label);
    const arm = builder.arm(base.id, callback);

    if (label === "default") {
      node.default = arm.entry;
    } else {
      entries.push([label, arm.entry]);
    }

    tails.push(...arm.tails);
  }

  node.cases = Object.fromEntries(entries);
  builder.continueFrom(base.id, tails);

  return builder.ref(base.id);
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
  const base = builder.allocate("map", null);
  const item = builder.binding(base.id, "item");
  const index = builder.binding(base.id, "index");

  const node = {
    ...base,
    kind: "map" as const,
    over: serializeRef(over, builder),
    body: base.id,
    item,
    index,
    concurrency: options.concurrency ?? 4,
    onError: options.onError,
  };

  builder.record(node);
  const arm = builder.arm(base.id, () => body(builder.ref(item), builder.ref(index)));
  node.body = arm.entry;

  for (const tail of arm.tails) {
    builder.edge(tail, base.id, "join");
  }

  builder.continueFrom(base.id, [base.id], "next");

  return builder.ref(base.id);
}

export function parallel<A extends Record<string, Arm>>(
  arms: A,
): Ref<{ [K in keyof A]: Result<ReturnType<A[K]>> }, { [K in keyof A]: Result<ReturnType<A[K]>> }> {
  const builder = currentBuilder();
  const base = builder.allocate("parallel", null);
  const node = { ...base, kind: "parallel" as const, branches: {} };
  builder.record(node);
  const tails = [];
  const entries = [];

  for (const [label, callback] of Object.entries(arms)) {
    validateLabel(label);
    const arm = builder.arm(base.id, callback);
    entries.push([label, arm.entry]);
    tails.push(...arm.tails);
  }

  node.branches = Object.fromEntries(entries);
  builder.continueFrom(base.id, tails);

  return builder.ref(base.id);
}

export function finally_<R extends AuthorValue>(body: () => R, cleanup: Arm): Ref<Result<R>> {
  const builder = currentBuilder();
  const base = builder.allocate("finally", null);
  const node = { ...base, kind: "finally" as const, body: base.id, cleanup: base.id };
  builder.record(node);
  const main = builder.arm(base.id, body);
  const final = builder.arm(base.id, cleanup);
  node.body = main.entry;
  node.cleanup = final.entry;
  builder.edge(base.id, main.entry, "next");
  builder.continueFrom(base.id, [...main.tails, ...final.tails]);

  return builder.ref(base.id);
}

export function rescue<R extends AuthorValue, H extends AuthorValue>(
  body: () => R,
  handler: (error: Ref<InferRecord<typeof ERROR_FIELDS>, InferRecord<typeof ERROR_FIELDS>>) => H,
): Ref<Result<R> | Result<H>> {
  const builder = currentBuilder();
  const base = builder.allocate("rescue", null);
  const error = builder.binding(base.id, "error");
  const node = { ...base, kind: "rescue" as const, body: base.id, handler: base.id, error };
  builder.record(node);
  const main = builder.arm(base.id, body);

  const caught = builder.arm(base.id, () =>
    handler(builder.ref(error, { kind: "record", fields: ERROR_FIELDS })),
  );

  node.body = main.entry;
  node.handler = caught.entry;
  builder.edge(base.id, main.entry, "next");
  builder.continueFrom(base.id, [...main.tails, ...caught.tails]);

  return builder.ref(base.id);
}

export function fail(message: string | Ref<string>): Ref<never> {
  const builder = currentBuilder();

  return builder.ref(builder.add({ kind: "fail", message: serialize(message, builder) }).id);
}
