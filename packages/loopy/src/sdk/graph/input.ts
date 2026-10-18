import type { RecordSpec } from "../../core/index.js";
import type { GraphBuilder } from "./builder.js";

export function inputRef<S extends RecordSpec>(builder: GraphBuilder, schema: S) {
  return builder.schemaRef("input", { kind: "record", fields: schema });
}
