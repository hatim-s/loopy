import { Schema } from "effect";
import {
  DIAGNOSTIC_CODES,
  EDGE_KINDS,
  EXECUTION_ERROR_CODES,
  EXECUTION_MODES,
  FIELD_TYPES,
  LOOPY_SCOPES,
  NODE_RUN_STATUSES,
  RECEIPT_KINDS,
} from "../core/index.js";
import { struct } from "./codec.js";
import { nodeSchema, nodeViewSchema } from "./graph-nodes.js";

import type { outputSchema, valueSchema } from "./graph-values.js";
import { graphRecord, labelSchema, nodeIdSchema, refSchema } from "./graph-values.js";
import { jsonSchema } from "./json.js";

export { nodeSchema } from "./graph-nodes.js";

export {
  nodeIdSchema,
  outputSchema,
  predicateSchema,
  refIdSchema,
  refSchema,
  valueSchema,
} from "./graph-values.js";

export const edgeSchema = Schema.Union([
  struct({
    from: nodeIdSchema,
    to: nodeIdSchema,
    kind: Schema.Literals(EDGE_KINDS.filter((kind) => kind !== "case")),
  }),
  struct({
    from: nodeIdSchema,
    to: nodeIdSchema,
    kind: Schema.Literal("case"),
    label: labelSchema,
  }),
]);

export const diagnosticSchema = struct({
  code: Schema.Literals(DIAGNOSTIC_CODES),
  message: Schema.String,
  node: Schema.NullOr(nodeIdSchema),
  source: Schema.NullOr(
    struct({
      module: Schema.String,
      line: Schema.Int.check(Schema.isGreaterThan(0)),
      column: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
});

export const graphMetaSchema = struct({
  description: Schema.NullOr(Schema.String),
  schedule: Schema.NullOr(struct({ cron: Schema.String, tz: Schema.optional(Schema.String) })),
  secrets: Schema.Array(Schema.String).pipe(Schema.mutable),
  mode: Schema.Literals(EXECUTION_MODES),
  scope: Schema.Literals(LOOPY_SCOPES),
});

export const graphSchema = struct({
  meta: graphMetaSchema,
  version: Schema.Literal(1),
  name: Schema.String,
  input: Schema.Union([graphRecord(Schema.Literals(FIELD_TYPES)), Schema.Literal("schema")]),
  inputValidation: Schema.optional(
    struct({
      minItems: graphRecord(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      unknownKeys: Schema.Literals(["strip", "reject", "passthrough"]),
      root: Schema.optional(Schema.Literal("json")),
    }),
  ),
  nodes: Schema.Array(nodeSchema).pipe(Schema.mutable),
  edges: Schema.Array(edgeSchema).pipe(Schema.mutable),
  entry: nodeIdSchema,
  outputs: Schema.NullOr(refSchema),
  warnings: Schema.Array(diagnosticSchema).pipe(Schema.mutable),
});

export const executionKeySchema = struct({
  runId: Schema.String,
  nodeId: nodeIdSchema,
  scope: Schema.Array(
    struct({ nodeId: nodeIdSchema, index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  ).pipe(Schema.mutable),
});

const runBase = struct({
  key: executionKeySchema,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)),
  startedAt: Schema.String,
  receipt: Schema.Literals(RECEIPT_KINDS),
  inputView: Schema.optional(
    Schema.Union([
      struct({ state: Schema.Literal("available"), value: jsonSchema }),
      struct({
        state: Schema.Literal("truncated"),
        bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ]),
  ),
});

export const executionErrorSchema = struct({
  code: Schema.Literals(EXECUTION_ERROR_CODES),
  message: Schema.String,
});

export const nodeRunSchema = Schema.Union([
  struct({ ...runBase.fields, status: Schema.Literal(NODE_RUN_STATUSES[0]) }),
  struct({ ...runBase.fields, status: Schema.Literal(NODE_RUN_STATUSES[7]) }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[9]),
    nextRetryAt: Schema.String,
  }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[8]),
    endedAt: Schema.String,
  }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[1]),
    output: jsonSchema,
    endedAt: Schema.String,
  }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[2]),
    error: executionErrorSchema,
    endedAt: Schema.String,
  }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[3]),
    error: executionErrorSchema,
    nextRetryAt: Schema.String,
    endedAt: Schema.String,
  }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[4]),
    wakeAt: Schema.NullOr(Schema.String),
  }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[5]),
    wakeAt: Schema.String,
  }),
  struct({
    ...runBase.fields,
    status: Schema.Literal(NODE_RUN_STATUSES[6]),
    endedAt: Schema.String,
  }),
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

export const nodeRunViewSchema = nodeRunSchema;

// A run pins one revision, so viewers name the revision beside the graph they draw.
export const graphRevisionViewSchema = struct({ revision: Schema.String, graph: graphViewSchema });

export type GraphView = Schema.Schema.Type<typeof graphViewSchema>;

export type GraphRevisionView = Schema.Schema.Type<typeof graphRevisionViewSchema>;

export type NodeRunView = Schema.Schema.Type<typeof nodeRunViewSchema>;

export type Graph = Schema.Schema.Type<typeof graphSchema>;

export type Node = Schema.Schema.Type<typeof nodeSchema>;

export type Edge = Schema.Schema.Type<typeof edgeSchema>;

export type Value = Schema.Schema.Type<typeof valueSchema>;

export type Ref = Schema.Schema.Type<typeof refSchema>;

export type OutSchema = Schema.Schema.Type<typeof outputSchema>;

export type Diagnostic = Schema.Schema.Type<typeof diagnosticSchema>;

export type ExecutionKey = Schema.Schema.Type<typeof executionKeySchema>;

export type NodeRun = Schema.Schema.Type<typeof nodeRunSchema>;
