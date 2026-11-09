import {
  fieldKey,
  type Ref as GraphRef,
  type OutSchema,
  type Predicate,
  type RefId,
  type Value,
} from "@loopy/core";
import { refuse } from "./validate";

export const REF = Symbol("loopy.graph.ref");

export type RefContext = {
  check(ref: RefValue): void;
};

type RefMetadata = {
  owner: RefContext;
  scope: symbol;
  id: RefId;
  schema: OutSchema | null;
};

export class RefValue {
  readonly [REF]: RefMetadata;
  constructor(
    metadata: RefMetadata,
    readonly path: string[] = [],
  ) {
    this[REF] = metadata;
  }
}

export class Reference<T, Fields = never> extends RefValue {
  declare readonly output: T;

  get<K extends [Fields] extends [never] ? never : keyof Fields & string>(key: K): Ref<Fields[K]> {
    const { schema } = this[REF];

    if (
      schema !== null &&
      schema.kind === "record" &&
      this.path.length === 0 &&
      !Object.keys(schema.fields).some((field) => fieldKey(field) === key)
    ) {
      refuse("unresolved_ref", "Reference paths must match the declared output schema.");
    }

    return new Reference(this[REF], [...this.path, String(key)]);
  }
}

export type Ref<T, Fields = never> = Omit<Reference<T, Fields>, "get"> &
  ([Fields] extends [never] ? object : Pick<Reference<T, Fields>, "get">);

export type AuthorValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | void
  | RefValue
  | readonly AuthorValue[]
  | { readonly [key: string]: AuthorValue; readonly [REF]?: never };

/** The length of a string or array ref, usable only as a comparison operand. */
export class Size {
  constructor(readonly ref: RefValue) {}
}

/** A predicate keeps its author values until the branch that uses it lowers them in its scope. */
export class Condition {
  readonly #lower: (context: RefContext) => Predicate;

  constructor(lower: (context: RefContext) => Predicate) {
    this.#lower = lower;
  }

  lower(context: RefContext): Predicate {
    return this.#lower(context);
  }
}

export function serializeRef(ref: RefValue, context: RefContext): GraphRef {
  context.check(ref);

  return { ref: ref[REF].id, path: [...ref.path] };
}

// BOUNDARY: Untyped author JavaScript may pass any value; the evaluator's graph decode checks the result.
export function serialize(value: AuthorValue, context: RefContext): Value {
  if (value === undefined) {
    return null;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (isRef(value)) {
    return serializeRef(value, context);
  }

  if (value instanceof Size) {
    refuse("invalid_size", "Size is allowed only in comparisons.");
  }

  if (value instanceof Condition) {
    refuse("predicate_type", "Conditions are allowed only as branch predicates.");
  }

  if (Array.isArray(value)) {
    return value.map((item: AuthorValue) => serialize(item, context));
  }

  if ("ref" in value) {
    refuse("unresolved_ref", "The 'ref' key is reserved for references.");
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, serialize(item, context)]),
  );
}

export function serializeValues(
  values: Readonly<Record<string, AuthorValue>>,
  context: RefContext,
) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, serialize(value, context)]),
  );
}

export function isRef(value: AuthorValue): value is RefValue {
  return value !== null && typeof value === "object" && REF in value;
}
