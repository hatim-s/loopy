import {
  codeNodeSchema,
  commandNodeSchema,
  DIAGNOSTIC_CODES,
  graphRecord,
  graphSchema,
  nodeIdSchema,
  otherNodeSchemas,
  struct,
  valueSchema,
} from "@loopy/core";
import { Schema } from "effect";

// Views drop module paths and parser bundle hashes, which name private registry files.
export const nodeViewSchema = Schema.Union([
  struct({ ...codeNodeSchema.fields, module: struct({ name: Schema.String }) }),
  struct({
    ...commandNodeSchema.fields,
    parse: Schema.NullOr(struct({ input: graphRecord(Schema.mutableKey(valueSchema)) })),
  }),
  ...otherNodeSchemas,
]);

export const graphViewSchema = struct({
  ...graphSchema.fields,
  nodes: Schema.Array(nodeViewSchema).pipe(Schema.mutable),
  warnings: Schema.Array(
    struct({
      code: Schema.Literals(DIAGNOSTIC_CODES),
      message: Schema.String,
      nodeId: Schema.NullOr(nodeIdSchema),
      label: Schema.NullOr(Schema.String),
    }),
  ).pipe(Schema.mutable),
});

export type GraphView = Schema.Schema.Type<typeof graphViewSchema>;

export const graphRevisionViewSchema = struct({ revision: Schema.String, graph: graphViewSchema });

export type GraphRevisionView = Schema.Schema.Type<typeof graphRevisionViewSchema>;
