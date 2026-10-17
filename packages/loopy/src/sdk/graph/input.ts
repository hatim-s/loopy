import type { RecordSpec } from "../../core/index.js";
import type { GraphBuilder } from "./builder.js";
import type { InferRecord } from "./types.js";

export function inputRef<S extends RecordSpec>(builder: GraphBuilder, schema: S) {
  return builder.ref<InferRecord<S>, InferRecord<S>>("input", { kind: "record", fields: schema });
}
