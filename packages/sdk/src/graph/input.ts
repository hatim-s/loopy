import type { RecordSpec } from "@loopy/core";
import type { GraphBuilder } from "./builder";
import type { InferRecord } from "./types";

export function inputRef<S extends RecordSpec>(builder: GraphBuilder, schema: S) {
  return builder.ref<InferRecord<S>, InferRecord<S>>("input", { kind: "record", fields: schema });
}
