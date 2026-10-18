import type { Field, InferRecord, OutSchema, RecordSpec } from "../../core/index.js";

import type { Ref, RefFields, RefResult, RefValue } from "./ref.js";

export type Infer<S extends OutSchema> = S extends {
  kind: "record";
  fields: infer F extends RecordSpec;
}
  ? InferRecord<F>
  : S extends { kind: "value"; type: infer T extends keyof Field }
    ? Field[T]
    : S extends null
      ? null
      : never;

export type SchemaFields<S extends OutSchema> = S extends { kind: "record" } ? Infer<S> : never;

export type Result<T> = T extends RefValue
  ? RefResult<T>
  : T extends object
    ? { [K in keyof T]: Result<T[K]> }
    : T;

export type { InferRecord } from "../../core/index.js";

type Returning<R> = R extends RefValue ? ([RefResult<R>] extends [never] ? never : R) : R;

type DeclaredRecord<R> = R extends RefValue
  ? [RefFields<R>] extends [never]
    ? false
    : true
  : false;

type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;

export type ControlFields<R> = [Returning<R>] extends [never]
  ? never
  : false extends DeclaredRecord<Returning<R>>
    ? never
    : true extends IsUnion<RefFields<Returning<R>>>
      ? never
      : RefFields<Returning<R>>;

export type ControlRef<R> = Ref<Result<R>, ControlFields<R>>;
