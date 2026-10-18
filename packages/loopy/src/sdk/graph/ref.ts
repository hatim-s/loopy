import {
  type Ref as GraphRef,
  isBoolean,
  isNumber,
  isString,
  type OutSchema,
  type RefId,
  type Value,
} from "../../core/index.js";
import type { Infer, SchemaFields } from "./types.js";
import { refuse } from "./validate.js";

export const REF = Symbol("loopy.graph.ref");

declare const OUTPUT: unique symbol;

export class Size {
  constructor(readonly ref: RefValue) {}
}

export type RefContext = {
  check(ref: RefValue): void;
};

export type RefMetadata = {
  owner: RefContext;
  id: RefId;
  schema: OutSchema | null;
  path: string[];
};

export class RefValue {
  readonly [REF]: RefMetadata;
  constructor(metadata: RefMetadata) {
    this[REF] = metadata;
  }
}

export class ScalarReference<T, Fields = never> extends RefValue {
  declare readonly [OUTPUT]: {
    value: T;
    fields: Fields;
    returns: [T] extends [never] ? false : true;
  };
}

export class Reference<T, Fields = never> extends ScalarReference<T, Fields> {
  get<K extends keyof Fields & string>(key: K): Ref<Fields[K]> {
    return new Reference({ ...this[REF], path: [...this[REF].path, key] });
  }
}

export type Ref<T, Fields = never> = ScalarReference<T, Fields> &
  ([Fields] extends [never] ? object : Pick<Reference<T, Fields>, "get">);

export type AuthorData<R> =
  | string
  | number
  | boolean
  | null
  | undefined
  | void
  | R
  | readonly AuthorData<R>[]
  | { readonly [key: string]: AuthorData<R> };

export type AuthorValue = AuthorData<RefValue & { readonly [OUTPUT]: { returns: true } }>;

export function serializeRef(ref: RefValue, context: RefContext): GraphRef {
  context.check(ref);

  return { ref: ref[REF].id, path: [...ref[REF].path] };
}

export function serialize(
  value: Readonly<Record<string, string | number | boolean | RefValue>>,
  context: RefContext,
): Record<string, string | number | boolean | GraphRef>;
export function serialize(
  value: Readonly<Record<string, AuthorData<RefValue>>>,
  context: RefContext,
): Record<string, Value>;
export function serialize(value: AuthorData<RefValue>, context: RefContext): Value;
export function serialize(value: AuthorData<RefValue>, context: RefContext): Value {
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
    return value.map((item: AuthorData<RefValue>) => serialize(item, context));
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

export function isRef<T>(value: T): value is T & RefValue {
  return value instanceof RefValue;
}

export function serializeSize(ref: RefValue, context: RefContext) {
  return { ...serializeRef(ref, context), size: true as const };
}

export type SchemaRef<S extends OutSchema> = Ref<Infer<S>, SchemaFields<S>>;

export type RefResult<T> = T extends { readonly [OUTPUT]: { value: infer R } } ? R : never;

export type RefFields<T> = T extends { readonly [OUTPUT]: { fields: infer F } } ? F : never;

export type NodeResult = AuthorValue | Ref<never>;
