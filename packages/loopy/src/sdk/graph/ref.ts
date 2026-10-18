import {
  type Ref as GraphRef,
  isBoolean,
  isNumber,
  isString,
  type OutSchema,
  type RefId,
  type Value,
} from "../../core/index.js";
import { refuse } from "./validate.js";

export const REF = Symbol("loopy.graph.ref");

export class Size {
  constructor(readonly ref: RefValue) {}
}

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

  get<K extends keyof Fields & string>(key: K): Ref<Fields[K]> {
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
  | { readonly [key: string]: AuthorValue };

export function serializeRef(ref: RefValue, context: RefContext): GraphRef {
  context.check(ref);

  return { ref: ref[REF].id, path: [...ref.path] };
}

export function serialize(value: AuthorValue, context: RefContext): Value {
  if (value === undefined) {
    return null;
  }

  if (value === null || isString(value) || isNumber(value) || isBoolean(value)) {
    return value;
  }

  if (isRef(value)) {
    return serializeRef(value, context);
  }

  if (value instanceof Size) {
    refuse("invalid_size", "Size is allowed only in comparisons.");
  }

  if (Array.isArray(value)) {
    return value.map((item: AuthorValue) => serialize(item, context));
  }

  if ("ref" in value) {
    refuse("reserved_name", "The 'ref' key is reserved for references.");
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      return [key, serialize(item, context)];
    }),
  );
}

export function serializeValues(
  values: Readonly<Record<string, AuthorValue>>,
  context: RefContext,
) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      return [key, serialize(value, context)];
    }),
  );
}

export function isRef<T>(value: T): value is T & RefValue {
  return value instanceof RefValue;
}

export function serializeSize(ref: RefValue, context: RefContext) {
  return { ...serializeRef(ref, context), size: true as const };
}
