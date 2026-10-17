import type { Json, OutputSchema, RecordSpec } from "../../core/index.js";

import type { Ref, RefValue } from "./ref.js";

type Field = { string: string; number: number; boolean: boolean; json: Json };

type ObjectOf<S extends RecordSpec> = {
  -readonly [K in keyof S as K extends `${string}?` ? never : K]: Field[S[K]];
} & {
  -readonly [K in keyof S as K extends `${infer Name}?` ? Name : never]?: Field[S[K]];
};

export type InferSchema<S extends OutputSchema> = S extends RecordSpec
  ? { [K in keyof ObjectOf<S>]: ObjectOf<S>[K] }
  : Json;

export type Result<T> = T extends RefValue & { readonly output: infer R }
  ? R
  : T extends readonly unknown[]
    ? { [K in keyof T]: Result<T[K]> }
    : T extends object
      ? { [K in keyof T]: Result<T[K]> }
      : T;

export type InputRefs<S extends RecordSpec> = {
  [K in keyof InferSchema<S>]-?: Ref<InferSchema<S>[K]>;
};
