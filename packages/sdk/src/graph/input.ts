import { INPUT_REF, type RecordSpec } from "@loopy/core";
import type { GraphBuilder } from "./builder";
import type { InferRecord } from "./types";

export function inputRef<S extends RecordSpec>(builder: GraphBuilder, schema: S) {
  return builder.ref<InferRecord<S>, InferRecord<S>>(INPUT_REF, { kind: "record", fields: schema });
}
