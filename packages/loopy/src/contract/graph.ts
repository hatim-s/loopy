import { z } from "zod";
import {
  COMPARISON_OPS,
  DIAGNOSTIC_CODES,
  type Duration,
  durationMs,
  EDGE_KINDS,
  EXECUTION_ERROR_CODES,
  EXECUTION_MODES,
  FIELD_TYPES,
  isRecord,
  type Json,
  LOOPY_SCOPES,
  MAP_ERROR_MODES,
  NODE_KINDS,
  NODE_RUN_STATUSES,
  type NodeId,
  predicateOps,
  RECEIPT_KINDS,
  RESERVED_GRAPH_NAMES,
  RETRY_BACKOFFS,
  type RefId,
} from "../core/index.js";
import { jsonSchema } from "./json.js";

// BOUNDARY: Graph ids are branded only after the wire has supplied nonempty strings.
export const nodeIdSchema = z.custom<NodeId>(
  (value): value is NodeId => typeof value === "string" && value.length > 0,
);

// BOUNDARY: Reference ids use their own brand at the graph boundary.
export const refIdSchema = z.custom<RefId>(
  (value): value is RefId => typeof value === "string" && value.length > 0,
);

const labelSchema = z
  .string()
  .refine(
    (name) => !RESERVED_GRAPH_NAMES.some((reserved) => reserved === name.replace(/\?$/, "")),
    { message: "Reserved graph names cannot be labels or record keys." },
  );

export const refSchema = z.strictObject({ ref: refIdSchema, path: z.array(z.string()) });

// BOUNDARY: Zod records skip __proto__ before validating keys, so inspect raw own keys first.
function graphRecord<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .refine(
      (value) =>
        !isRecord(value) || Object.keys(value).every((name) => labelSchema.safeParse(name).success),
      { message: "Reserved graph names cannot be record keys." },
    )
    .pipe(z.record(labelSchema, schema));
}

// 'ref' is reserved in object values so malformed references cannot pass as JSON literals.
const literalSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    refSchema,
    z.array(literalSchema),
    graphRecord(literalSchema).refine((value) => !Object.hasOwn(value, "ref")),
  ]),
);

export const valueSchema = z.union([refSchema, literalSchema]);

export const outputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("record"),
    fields: graphRecord(z.enum(FIELD_TYPES)).readonly(),
  }),
  z.strictObject({ kind: z.literal("value"), type: z.enum(FIELD_TYPES) }),
]);

const operandSchema = z.union([refSchema.extend({ size: z.literal(true) }), valueSchema]);

export const predicateSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.enum(COMPARISON_OPS), left: operandSchema, right: operandSchema }),
  z.strictObject({ op: z.enum(predicateOps("presence")), value: valueSchema }),
  z.strictObject({
    op: z.enum(predicateOps("group")),
    get predicates() {
      return z.array(predicateSchema);
    },
  }),
  z.strictObject({
    op: z.enum(predicateOps("negation")),
    get predicate() {
      return predicateSchema;
    },
  }),
]);

// BOUNDARY: Durations arrive as JSON numbers or unit-suffixed strings.
const durationSchema = z.custom<Duration>((value): value is Duration =>
  typeof value === "number"
    ? Number.isFinite(value) && value >= 0
    : typeof value === "string" && /^\d+(?:\.\d+)?[smhd]$/.test(value),
);

const rateLimitSchema = z.strictObject({
  key: z.string().min(1),
  limit: z.number().int().positive(),
  window: durationSchema.refine((value) => durationMs(value) > 0),
});

const retrySchema = z.strictObject({
  attempts: z.number().int().positive(),
  backoff: z.enum(RETRY_BACKOFFS),
  retryOnExit: z.boolean(),
});

const base = z.strictObject({
  id: nodeIdSchema,
  label: labelSchema.nullable(),
  scope: nodeIdSchema.nullable(),
});

const code = base.extend({
  kind: z.literal(NODE_KINDS[0]),
  in: graphRecord(valueSchema),
  out: outputSchema,
  module: z.strictObject({ path: z.string(), bundleHash: z.string().nullable() }),
  rateLimit: rateLimitSchema.nullable(),
  retry: retrySchema,
  timeout: durationSchema.nullable(),
});

const commandFlagSchema = z
  .strictObject({
    cli: z.string(),
    kind: z.enum(["boolean", "string", "number"]),
    repeatable: z.boolean().optional(),
    optionalValue: z.boolean().optional(),
    choices: z.array(z.string()).readonly().optional(),
    supported: z.boolean().optional(),
    style: z.enum(["equals", "space", "attached", "positional"]).optional(),
    position: z.enum(["before", "after"]).optional(),
    order: z.number().optional(),
    prefix: z.array(z.string()).readonly().optional(),
    pairs: z.boolean().optional(),
    terminator: z.string().optional(),
  })
  .readonly();

const commandFlagSpecSchema = z.strictObject({
  path: z.array(z.string()),
  flags: graphRecord(commandFlagSchema),
  style: z.enum(["equals", "space"]),
  positionalSeparator: z.boolean(),
  flagsAfterPositionals: z.boolean(),
});

const command = base.extend({
  kind: z.literal(NODE_KINDS[1]),
  key: z.string(),
  out: outputSchema,
  argv: z.array(valueSchema),
  flags: graphRecord(valueSchema),
  flagSpec: commandFlagSpecSchema.optional(),
  options: z.strictObject({
    cwd: valueSchema.nullable(),
    env: graphRecord(valueSchema),
    stdin: valueSchema.nullable(),
  }),
  rateLimit: rateLimitSchema.nullable(),
  retry: retrySchema,
  okExitCodes: z.array(z.number().int()),
  parse: z
    .strictObject({ bundleHash: z.string().nullable(), input: graphRecord(valueSchema) })
    .nullable(),
});

const otherNodes = [
  base.extend({
    kind: z.literal(NODE_KINDS[2]),
    predicate: predicateSchema,
    arms: z.strictObject({ yes: nodeIdSchema, no: nodeIdSchema }),
  }),
  base.extend({
    kind: z.literal(NODE_KINDS[3]),
    on: refSchema,
    cases: graphRecord(nodeIdSchema),
    default: nodeIdSchema.nullable(),
  }),
  base.extend({
    kind: z.literal(NODE_KINDS[4]),
    over: refSchema,
    body: nodeIdSchema,
    item: refIdSchema,
    index: refIdSchema,
    concurrency: z.number().int().positive(),
    onError: z.enum(MAP_ERROR_MODES),
  }),
  base.extend({ kind: z.literal(NODE_KINDS[5]), branches: graphRecord(nodeIdSchema) }),
  base.extend({
    kind: z.literal(NODE_KINDS[6]),
    timeout: durationSchema.nullable(),
    payload: outputSchema,
  }),
  base.extend({ kind: z.literal(NODE_KINDS[7]), duration: durationSchema }),
  base.extend({ kind: z.literal(NODE_KINDS[8]), body: nodeIdSchema, cleanup: nodeIdSchema }),
  base.extend({
    kind: z.literal(NODE_KINDS[9]),
    body: nodeIdSchema,
    handler: nodeIdSchema,
    error: refIdSchema,
  }),
  base.extend({ kind: z.literal(NODE_KINDS[10]), message: valueSchema }),
  base.extend({
    kind: z.literal(NODE_KINDS[11]),
    template: z.string(),
    values: graphRecord(z.union([z.string(), z.number(), z.boolean(), refSchema])),
  }),
  base.extend({
    kind: z.literal(NODE_KINDS[12]),
    message: valueSchema,
    data: valueSchema.nullable(),
  }),
  base.extend({ kind: z.literal(NODE_KINDS[13]) }),
  base.extend({ kind: z.literal(NODE_KINDS[14]) }),
  base.extend({ kind: z.literal(NODE_KINDS[15]) }),
  base.extend({
    kind: z.literal(NODE_KINDS[16]),
    result: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("value"), value: valueSchema }),
      z.strictObject({ kind: z.literal("none") }),
    ]),
  }),
] as const;

export const nodeSchema = z.discriminatedUnion("kind", [code, command, ...otherNodes]);

export const edgeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    from: nodeIdSchema,
    to: nodeIdSchema,
    kind: z.enum(EDGE_KINDS.filter((kind) => kind !== "case")),
  }),
  z.strictObject({
    from: nodeIdSchema,
    to: nodeIdSchema,
    kind: z.literal("case"),
    label: labelSchema,
  }),
]);

export const diagnosticSchema = z.strictObject({
  code: z.enum(DIAGNOSTIC_CODES),
  message: z.string(),
  node: nodeIdSchema.nullable(),
  source: z
    .strictObject({
      module: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    })
    .nullable(),
});

export const graphMetaSchema = z.strictObject({
  description: z.string().nullable(),
  schedule: z.strictObject({ cron: z.string(), tz: z.string().optional() }).nullable(),
  secrets: z.array(z.string()),
  mode: z.enum(EXECUTION_MODES),
  scope: z.enum(LOOPY_SCOPES),
});

export const graphSchema = z.strictObject({
  meta: graphMetaSchema,
  version: z.literal(1),
  name: z.string(),
  input: z.union([graphRecord(z.enum(FIELD_TYPES)).readonly(), z.literal("schema")]),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  entry: nodeIdSchema,
  outputs: refSchema.nullable(),
  warnings: z.array(diagnosticSchema),
});

export const executionKeySchema = z.strictObject({
  runId: z.string(),
  nodeId: nodeIdSchema,
  scope: z.array(z.strictObject({ nodeId: nodeIdSchema, index: z.number().int().nonnegative() })),
});

const runBase = z.strictObject({
  key: executionKeySchema,
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  startedAt: z.string(),
  receipt: z.enum(RECEIPT_KINDS),
});

export const executionErrorSchema = z.strictObject({
  code: z.enum(EXECUTION_ERROR_CODES),
  message: z.string(),
});

export const nodeRunSchema = z.discriminatedUnion("status", [
  runBase.extend({ status: z.literal(NODE_RUN_STATUSES[0]) }),
  runBase.extend({ status: z.literal(NODE_RUN_STATUSES[7]) }),
  runBase.extend({ status: z.literal(NODE_RUN_STATUSES[9]), nextRetryAt: z.string() }),
  runBase.extend({ status: z.literal(NODE_RUN_STATUSES[8]), endedAt: z.string() }),
  runBase.extend({
    status: z.literal(NODE_RUN_STATUSES[1]),
    output: jsonSchema,
    endedAt: z.string(),
  }),
  runBase.extend({
    status: z.literal(NODE_RUN_STATUSES[2]),
    error: executionErrorSchema,
    endedAt: z.string(),
  }),
  runBase.extend({
    status: z.literal(NODE_RUN_STATUSES[3]),
    error: executionErrorSchema,
    nextRetryAt: z.string(),
    endedAt: z.string(),
  }),
  runBase.extend({ status: z.literal(NODE_RUN_STATUSES[4]), wakeAt: z.string().nullable() }),
  runBase.extend({ status: z.literal(NODE_RUN_STATUSES[5]), wakeAt: z.string() }),
  runBase.extend({ status: z.literal(NODE_RUN_STATUSES[6]), endedAt: z.string() }),
]);

const nodeViewSchema = z.discriminatedUnion("kind", [
  code.extend({ module: z.strictObject({ name: z.string() }) }),
  command.extend({ parse: z.strictObject({ input: graphRecord(valueSchema) }).nullable() }),
  ...otherNodes,
]);

export const graphViewSchema = graphSchema.extend({
  nodes: z.array(nodeViewSchema),
  warnings: z.array(
    z.strictObject({
      code: z.enum(DIAGNOSTIC_CODES),
      message: z.string(),
      nodeId: nodeIdSchema.nullable(),
      label: z.string().nullable(),
    }),
  ),
});

export const nodeRunViewSchema = nodeRunSchema;

export type GraphView = z.infer<typeof graphViewSchema>;

export type NodeRunView = z.infer<typeof nodeRunViewSchema>;

export type Graph = z.infer<typeof graphSchema>;

export type Node = z.infer<typeof nodeSchema>;

export type Edge = z.infer<typeof edgeSchema>;

export type Value = z.infer<typeof valueSchema>;

export type Ref = z.infer<typeof refSchema>;

export type OutSchema = z.infer<typeof outputSchema>;

export type Diagnostic = z.infer<typeof diagnosticSchema>;

export type ExecutionKey = z.infer<typeof executionKeySchema>;

export type NodeRun = z.infer<typeof nodeRunSchema>;
