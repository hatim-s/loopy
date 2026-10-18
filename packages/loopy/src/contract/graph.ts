import { z } from "zod";
import {
  COMPARISON_OPS,
  DIAGNOSTIC_CODES,
  DURATION_PATTERN,
  durationMs,
  EDGE_KINDS,
  EXECUTION_ERROR_CODES,
  EXECUTION_MODES,
  FIELD_TYPES,
  FLAG_KINDS,
  FLAG_POSITIONS,
  FLAG_STYLES,
  isRecord,
  isReservedGraphName,
  type Json,
  LOOPY_SCOPES,
  MAP_ERROR_MODES,
  type NodeId,
  predicateOps,
  RECEIPT_KINDS,
  RETRY_BACKOFFS,
  type RefId,
} from "../core/index.js";
import { jsonSchema } from "./json.js";
import { secretNameSchema, slugSchema, utcTimestamp } from "./primitives.js";

// Graph ids are branded only after the wire has supplied nonempty strings.
export const nodeIdSchema = z.custom<NodeId>(
  (value): value is NodeId => typeof value === "string" && value.length > 0,
);

// Reference ids use their own brand at the graph boundary.
export const refIdSchema = z.custom<RefId>(
  (value): value is RefId => typeof value === "string" && value.length > 0,
);

export const labelSchema = z.string().refine((name) => !isReservedGraphName(name), {
  message: "Reserved graph names cannot be labels or record keys.",
});

export const refSchema = z.strictObject({ ref: refIdSchema, path: z.array(z.string()) });

// Zod records skip __proto__ before validating keys, so inspect raw own keys first.
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

export const durationSchema = z.union([
  z.number().nonnegative(),
  z
    .templateLiteral([z.number().nonnegative(), z.enum(["s", "m", "h", "d"])])
    .refine((value) => DURATION_PATTERN.test(value)),
]);

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
  kind: z.literal("code"),
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
    kind: z.enum(FLAG_KINDS),
    repeatable: z.boolean().optional(),
    optionalValue: z.boolean().optional(),
    choices: z.array(z.string()).readonly().optional(),
    supported: z.boolean().optional(),
    style: z.enum(FLAG_STYLES).optional(),
    position: z.enum(FLAG_POSITIONS).optional(),
    order: z.number().optional(),
    prefix: z.array(z.string()).readonly().optional(),
    pairs: z.boolean().optional(),
    terminator: z.string().optional(),
  })
  .readonly();

const commandFlagSpecSchema = z.strictObject({
  path: z.array(z.string()),
  flags: graphRecord(commandFlagSchema),
  style: z.enum(FLAG_STYLES.filter((style) => style === "equals" || style === "space")),
  positionalSeparator: z.boolean(),
  flagsAfterPositionals: z.boolean(),
});

export const commandNodeSchema = base.extend({
  kind: z.literal("command"),
  key: z.string(),
  out: outputSchema,
  argv: z.array(valueSchema),
  flags: graphRecord(valueSchema),
  flagSpec: commandFlagSpecSchema.nullable(),
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
    kind: z.literal("branch"),
    predicate: predicateSchema,
    arms: z.strictObject({ yes: nodeIdSchema, no: nodeIdSchema }),
  }),
  base.extend({
    kind: z.literal("switch"),
    on: refSchema,
    cases: graphRecord(nodeIdSchema),
    default: nodeIdSchema.nullable(),
  }),
  base.extend({
    kind: z.literal("map"),
    over: refSchema,
    body: nodeIdSchema,
    item: refIdSchema,
    index: refIdSchema,
    concurrency: z.number().int().positive(),
    onError: z.enum(MAP_ERROR_MODES),
  }),
  base.extend({ kind: z.literal("parallel"), branches: graphRecord(nodeIdSchema) }),
  base.extend({
    kind: z.literal("wait"),
    timeout: durationSchema.nullable(),
    payload: outputSchema,
  }),
  base.extend({ kind: z.literal("sleep"), duration: durationSchema }),
  base.extend({ kind: z.literal("finally"), body: nodeIdSchema, cleanup: nodeIdSchema }),
  base.extend({
    kind: z.literal("rescue"),
    body: nodeIdSchema,
    handler: nodeIdSchema,
    error: refIdSchema,
  }),
  base.extend({ kind: z.literal("fail"), message: valueSchema }),
  base.extend({
    kind: z.literal("format"),
    template: z.string(),
    values: graphRecord(z.union([z.string(), z.number(), z.boolean(), refSchema])),
  }),
  base.extend({
    kind: z.literal("log"),
    message: valueSchema,
    data: valueSchema.nullable(),
  }),
  base.extend({ kind: z.literal("now") }),
  base.extend({ kind: z.literal("uuid") }),
  base.extend({ kind: z.literal("random") }),
  base.extend({
    kind: z.literal("join"),
    result: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("value"), value: valueSchema }),
      z.strictObject({ kind: z.literal("none") }),
    ]),
  }),
] as const;

export const nodeSchema = z.discriminatedUnion("kind", [code, commandNodeSchema, ...otherNodes]);

export const edgeSchema = z.strictObject({
  from: nodeIdSchema,
  to: nodeIdSchema,
  kind: z.enum(EDGE_KINDS),
});

const viewEdgeSchema = z.union([
  edgeSchema,
  z.strictObject({
    from: nodeIdSchema,
    to: nodeIdSchema,
    kind: z.enum(["yes", "no", "each", "cleanup", "rescue"]),
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
  schedule: z.strictObject({ cron: z.string(), tz: z.string() }).nullable(),
  secrets: z.array(secretNameSchema),
  mode: z.enum(EXECUTION_MODES),
  scope: z.enum(LOOPY_SCOPES),
});

export const graphSchema = z.strictObject({
  meta: graphMetaSchema,
  version: z.literal(1),
  name: slugSchema,
  input: graphRecord(z.enum(FIELD_TYPES)).readonly(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  entry: nodeIdSchema,
  outputs: refSchema.nullable(),
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
  startedAt: utcTimestamp,
  receipt: z.enum(RECEIPT_KINDS),
});

export const executionErrorSchema = z.strictObject({
  code: z.enum(EXECUTION_ERROR_CODES),
  message: z.string(),
});

export const nodeRunSchema = z.discriminatedUnion("status", [
  runBase.extend({ status: z.literal("running") }),
  runBase.extend({ status: z.literal("rate_limited"), nextRetryAt: utcTimestamp }),
  runBase.extend({
    status: z.literal("succeeded"),
    output: jsonSchema,
    endedAt: utcTimestamp,
  }),
  runBase.extend({
    status: z.literal("failed"),
    error: executionErrorSchema,
    endedAt: utcTimestamp,
  }),
  runBase.extend({
    status: z.literal("retrying"),
    error: executionErrorSchema,
    nextRetryAt: utcTimestamp,
    endedAt: utcTimestamp,
  }),
  runBase.extend({ status: z.literal("waiting"), wakeAt: utcTimestamp.nullable() }),
  runBase.extend({ status: z.literal("sleeping"), wakeAt: utcTimestamp }),
  runBase.extend({ status: z.literal("cancelled"), endedAt: utcTimestamp }),
]);

const nodeViewSchema = z.discriminatedUnion("kind", [
  code.extend({ module: z.strictObject({ name: z.string() }) }),
  commandNodeSchema.extend({
    parse: z.strictObject({ input: graphRecord(valueSchema) }).nullable(),
  }),
  ...otherNodes,
]);

export const graphViewSchema = graphSchema.extend({
  nodes: z.array(nodeViewSchema),
  edges: z.array(viewEdgeSchema),
});

export type GraphView = z.infer<typeof graphViewSchema>;

export type {
  Diagnostic,
  Edge,
  ExecutionKey,
  Graph,
  Node,
  NodeRun,
  OutSchema,
  Ref,
  Value,
} from "../core/index.js";
