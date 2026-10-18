import type { Field, InferRecord, OutSchema, RecordSpec } from "../../core/index.js";

import type { Ref } from "./ref.js";

export type Infer<S extends OutSchema> = S extends {
  kind: "record";
  fields: infer F extends RecordSpec;
}
  ? InferRecord<F>
  : S extends { kind: "value"; type: infer T extends keyof Field }
    ? Field[T]
    : never;

export type SchemaFields<S extends OutSchema> = S extends { kind: "record" } ? Infer<S> : never;

export type Result<T> = T extends Ref<infer R>
  ? R
  : T extends object
    ? { [K in keyof T]: Result<T[K]> }
    : T;

export type { InferRecord } from "../../core/index.js";
