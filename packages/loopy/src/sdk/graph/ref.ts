import type { Ref as GraphRef, OutSchema, RefId, Value } from "../../core/index.js";
import { refuse } from "./validate.js";

export const REF = Symbol("loopy.graph.ref");

export const SIZE = Symbol("loopy.graph.size");

const origins = new WeakMap<object, RefValue>();

export type RefContext = {
  check(ref: RefValue): void;
};

export type RefMetadata = {
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
      !Object.hasOwn(schema.fields, key) &&
      !Object.hasOwn(schema.fields, `${String(key)}?`)
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
  | { readonly [key: string]: AuthorValue; readonly [SIZE]?: never; readonly [REF]?: never };

export type Size = { readonly [SIZE]: RefValue };

export function serializeRef(ref: RefValue, context: RefContext): GraphRef {
  context.check(ref);

  const value = { ref: ref[REF].id, path: [...ref.path] };
  origins.set(value, ref);

  return value;
}

// BOUNDARY: Author literals and branded refs are lowered to JSON with one recursive set of rules.
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

  if (SIZE in value) {
    refuse("invalid_size", "Size is allowed only in comparisons.");
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

// BOUNDARY: Predicate JSON retains its originating handles for scope checks before graph emission.
export function checkSerialized(value: Value, context: RefContext): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  const origin = origins.get(value);

  if (origin) {
    context.check(origin);

    return;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      checkSerialized(child, context);
    }

    return;
  }

  for (const child of Object.values(value)) {
    checkSerialized(child, context);
  }
}

export function serializeSize(ref: RefValue, context: RefContext) {
  const value = { ...serializeRef(ref, context), size: true as const };
  origins.set(value, ref);

  return value;
}
