import { Schema } from "effect";
import { counter, positiveInt, struct } from "../codec";
import { EXECUTION_MODES } from "../model";
import { nodeSchema } from "./nodes";
import { graphRecord, labelSchema, nodeIdSchema, recordSpecSchema, refSchema } from "./values";

export * from "./key";

export * from "./node-run";

export * from "./nodes";

export * from "./values";

export const edgeSchema = Schema.Union([
  struct({
    from: nodeIdSchema,
    to: nodeIdSchema,
    kind: Schema.Literals(["next", "yes", "no", "each", "join", "cleanup", "rescue"]),
  }),
  struct({
    from: nodeIdSchema,
    to: nodeIdSchema,
    kind: Schema.Literal("case"),
    label: labelSchema,
  }),
]);

export type Edge = Schema.Schema.Type<typeof edgeSchema>;

export type EdgeKind = Edge["kind"];

export const DIAGNOSTIC_CODES = [
  "duplicate_label",
  "reserved_name",
  "inactive_builder",
  "duplicate_node",
  "duplicate_ref",
  "missing_endpoint",
  "missing_entry",
  "unresolved_ref",
  "out_of_scope_ref",
  "predicate_type",
  "format_type",
  "input_validation",
  "invalid_size",
  "missing_arm",
  "invalid_scope",
  "cycle",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export const diagnosticSchema = struct({
  code: Schema.Literals(DIAGNOSTIC_CODES),
  message: Schema.String,
  node: Schema.NullOr(nodeIdSchema),
  source: Schema.NullOr(struct({ module: Schema.String, line: positiveInt, column: positiveInt })),
});

export type Diagnostic = Schema.Schema.Type<typeof diagnosticSchema>;

export const LOOPY_SCOPES = ["project", "global"] as const;

// Schedules without an author-chosen zone fire in UTC.
export const DEFAULT_TIME_ZONE = "UTC";

export const graphMetaSchema = struct({
  description: Schema.NullOr(Schema.String),
  schedule: Schema.NullOr(struct({ cron: Schema.String, tz: Schema.String })),
  secrets: Schema.Array(Schema.String).pipe(Schema.mutable),
  mode: Schema.Literals(EXECUTION_MODES),
  scope: Schema.Literals(LOOPY_SCOPES),
});

export type GraphMeta = Schema.Schema.Type<typeof graphMetaSchema>;

export const UNKNOWN_KEY_MODES = ["strip", "reject", "passthrough"] as const;

export const inputValidationSchema = struct({
  minItems: graphRecord(counter),
  unknownKeys: Schema.Literals(UNKNOWN_KEY_MODES),
  root: Schema.optional(Schema.Literal("json")),
});

export type InputValidation = Schema.Schema.Type<typeof inputValidationSchema>;

export const graphSchema = struct({
  meta: graphMetaSchema,
  version: Schema.Literal(1),
  name: Schema.String,
  input: Schema.Union([recordSpecSchema, Schema.Literal("schema")]),
  inputValidation: Schema.optional(inputValidationSchema),
  nodes: Schema.Array(nodeSchema).pipe(Schema.mutable),
  edges: Schema.Array(edgeSchema).pipe(Schema.mutable),
  entry: nodeIdSchema,
  outputs: Schema.NullOr(refSchema),
  warnings: Schema.Array(diagnosticSchema).pipe(Schema.mutable),
});

export type Graph = Schema.Schema.Type<typeof graphSchema>;
