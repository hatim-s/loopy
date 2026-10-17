import type { RecordSpec } from "../../core/index.js";
import type { GraphBuilder } from "./builder.js";
import type { InferSchema } from "./types.js";

export function inputRef<S extends RecordSpec>(builder: GraphBuilder, schema: S) {
  return builder.ref<InferSchema<S>>("input", schema);
}
