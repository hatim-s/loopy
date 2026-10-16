import type { StandardSchemaV1 } from "./schema.js";

export type Issue = {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
};

export type Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly Issue[] };

export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"];
