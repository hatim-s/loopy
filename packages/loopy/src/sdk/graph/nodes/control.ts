// Every control node kind lives here on purpose: they share arm, join and result construction.
import {
  type Collected,
  ERROR_FIELDS,
  type MAP_ERROR_MODES,
  type Node,
} from "../../../core/index.js";
import { currentBuilder, type GraphBuilder } from "../builder.js";
import { type AuthorPredicate, serializePredicate } from "../predicates.js";
import { type NodeResult, type Ref, type SchemaRef, serialize, serializeRef } from "../ref.js";
import type { ControlRef, Result } from "../types.js";
import { validatePredicate } from "../validate.js";

type Arm = () => NodeResult;

export function branch<Y extends NodeResult, N extends NodeResult>(
  predicate: AuthorPredicate,
  arms: { yes: () => Y; no: () => N },
): ControlRef<Y | N> {
  const builder = currentBuilder();
  const base = builder.allocate("branch", { fallback: "branch" });
  const recorded = serializePredicate(predicate, builder);
  validatePredicate(recorded, builder);

  // Install the control before expanding callbacks so nested nodes keep call-order identity.
  const node = {
    ...base,
    kind: "branch" as const,
    predicate: recorded,
    arms: { yes: base.id, no: base.id },
  };

  builder.record(node);
  twoArms(builder, node, [arms.yes, arms.no]);

  return builder.controlRef(base.id, arms);
}

export function switch_<A extends Record<string, Arm>>(
  on: Ref<string | number | boolean>,
  arms: A & { default: Arm },
): ControlRef<ReturnType<A[keyof A]>> {
  const builder = currentBuilder();
  const base = builder.allocate("switch", { fallback: "switch" });

  const node = {
    ...base,
    kind: "switch" as const,
    on: serializeRef(on, builder),
    cases: {},
    default: base.id,
  };

  builder.record(node);
  const { entries, tails } = builder.arms(base.id, arms);
  const cases: [string, Node["id"]][] = [];

  for (const [label, entry] of entries) {
    if (label === "default") {
      node.default = entry;
    } else {
      cases.push([label, entry]);
    }
  }

  node.cases = Object.fromEntries(cases);
  builder.continueFrom(base.id, tails);

  return builder.controlRef(base.id, arms);
}

export function map<T, R extends NodeResult, M extends (typeof MAP_ERROR_MODES)[number]>(
  over: Ref<T[]>,
  body: (item: Ref<T>, index: Ref<number>) => R,
  options: { concurrency?: number; onError: M },
): Ref<(M extends "collect" ? Collected<Result<R>> : Result<R>)[]> {
  const builder = currentBuilder();
  const base = builder.allocate("map", { fallback: "map" });
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
  const arm = builder.arm(base.id, () => body(builder.scalarRef(item), builder.scalarRef(index)));
  node.body = arm.entry;

  for (const tail of arm.tails) {
    builder.edge(tail, base.id, "join");
  }

  builder.continueFrom(base.id, [base.id], "next");

  return builder.scalarRef(base.id);
}

export function parallel<A extends Record<string, Arm>>(
  arms: A,
): Ref<{ [K in keyof A]: Result<ReturnType<A[K]>> }, { [K in keyof A]: Result<ReturnType<A[K]>> }> {
  const builder = currentBuilder();
  const base = builder.allocate("parallel", { fallback: "parallel" });
  const node = { ...base, kind: "parallel" as const, branches: {} };
  builder.record(node);
  const { entries, tails } = builder.arms(base.id, arms);
  node.branches = Object.fromEntries(entries);
  builder.continueFrom(base.id, tails);

  return builder.parallelRef(base.id, arms);
}

export function finally_<R extends NodeResult>(body: () => R, cleanup: Arm): ControlRef<R> {
  const builder = currentBuilder();
  const base = builder.allocate("finally", { fallback: "finally" });
  const node = { ...base, kind: "finally" as const, body: base.id, cleanup: base.id };
  builder.record(node);
  twoArms(builder, node, [body, cleanup]);

  return builder.controlRef(base.id, { body });
}

export function rescue<R extends NodeResult, H extends NodeResult>(
  body: () => R,
  handler: (error: SchemaRef<{ kind: "record"; fields: typeof ERROR_FIELDS }>) => H,
): ControlRef<R | H> {
  const builder = currentBuilder();
  const base = builder.allocate("rescue", { fallback: "rescue" });
  const error = builder.binding(base.id, "error");
  const node = { ...base, kind: "rescue" as const, body: base.id, handler: base.id, error };
  builder.record(node);
  twoArms(builder, node, [
    body,
    () => handler(builder.schemaRef(error, { kind: "record", fields: ERROR_FIELDS })),
  ]);

  return builder.controlRef(base.id, { body, handler });
}

export function fail(message: string | Ref<string>): Ref<never> {
  const builder = currentBuilder();

  return builder.scalarRef(builder.add({ kind: "fail", message: serialize(message, builder) }).id);
}

function twoArms(
  builder: GraphBuilder,
  node: Extract<Node, { kind: "branch" | "finally" | "rescue" }>,
  callbacks: readonly [Arm, Arm],
) {
  const first = builder.arm(node.id, callbacks[0]);
  const second = builder.arm(node.id, callbacks[1]);

  if (node.kind === "branch") {
    node.arms = { yes: first.entry, no: second.entry };
  } else {
    node.body = first.entry;

    if (node.kind === "finally") {
      node.cleanup = second.entry;
    } else {
      node.handler = second.entry;
    }

    builder.edge(node.id, first.entry, "next");
  }

  builder.continueFrom(node.id, [...first.tails, ...second.tails]);
}
