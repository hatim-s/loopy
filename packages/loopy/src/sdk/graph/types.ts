import type { Json, OutSchema, RecordSpec } from "../../core/index.js";

import type { RefValue } from "./ref.js";

type Field = {
  string: string;
  number: number;
  boolean: boolean;
  json: Json;
  "string[]": string[];
  "number[]": number[];
  "boolean[]": boolean[];
  "json[]": Json[];
};

type ObjectOf<S extends RecordSpec> = {
  -readonly [K in keyof S as K extends `${string}?` ? never : K]: Field[S[K]];
} & {
  -readonly [K in keyof S as K extends `${infer Name}?` ? Name : never]?: Field[S[K]];
};

export type InferRecord<S extends RecordSpec> = { [K in keyof ObjectOf<S>]: ObjectOf<S>[K] };

export type Infer<S extends OutSchema> = S extends {
  kind: "record";
  fields: infer F extends RecordSpec;
}
  ? InferRecord<F>
  : S extends { kind: "value"; type: infer T extends keyof Field }
    ? Field[T]
    : never;

export type SchemaFields<S extends OutSchema> = S extends { kind: "record" } ? Infer<S> : never;

export type Result<T> = T extends RefValue & { readonly output: infer R }
  ? R
  : T extends readonly unknown[]
    ? { [K in keyof T]: Result<T[K]> }
    : T extends object
      ? { [K in keyof T]: Result<T[K]> }
      : T;
