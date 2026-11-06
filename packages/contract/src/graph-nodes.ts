import { durationMs, MAP_ERROR_MODES, NODE_KINDS, RETRY_BACKOFFS } from "@loopy/core";
import { Schema } from "effect";
import { struct } from "./codec";

import {
  durationSchema,
  graphRecord,
  labelSchema,
  nodeIdSchema,
  outputSchema,
  predicateSchema,
  refIdSchema,
  refSchema,
  valueSchema,
} from "./graph-values";

const rateLimitSchema = struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
  window: durationSchema.check(
    Schema.makeFilter((value) => durationMs(value) > 0, {
      message: "Supply a positive rate-limit window.",
    }),
  ),
});

const retrySchema = struct({
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  backoff: Schema.Literals(RETRY_BACKOFFS),
  retryOnExit: Schema.Boolean,
});

const base = struct({
  id: nodeIdSchema,
  label: Schema.NullOr(labelSchema),
  scope: Schema.NullOr(nodeIdSchema),
});

const code = struct({
  ...base.fields,
  kind: Schema.Literal(NODE_KINDS[0]),
  in: graphRecord(Schema.mutableKey(valueSchema)),
  out: outputSchema,
  module: struct({ path: Schema.String, bundleHash: Schema.NullOr(Schema.String) }),
  rateLimit: Schema.NullOr(rateLimitSchema),
  retry: retrySchema,
  timeout: Schema.NullOr(durationSchema),
});

const commandFlagSchema = Schema.Struct({
  cli: Schema.String,
  kind: Schema.Literals(["boolean", "string", "number"]),
  repeatable: Schema.optional(Schema.Boolean),
  optionalValue: Schema.optional(Schema.Boolean),
  choices: Schema.optional(Schema.Array(Schema.String)),
  supported: Schema.optional(Schema.Boolean),
  style: Schema.optional(Schema.Literals(["equals", "space", "attached", "positional"])),
  position: Schema.optional(Schema.Literals(["before", "after"])),
  order: Schema.optional(Schema.Finite),
  prefix: Schema.optional(Schema.Array(Schema.String)),
  pairs: Schema.optional(Schema.Boolean),
  terminator: Schema.optional(Schema.String),
});

const commandFlagSpecSchema = struct({
  path: Schema.Array(Schema.String).pipe(Schema.mutable),
  flags: graphRecord(Schema.mutableKey(commandFlagSchema)),
  style: Schema.Literals(["equals", "space"]),
  positionalSeparator: Schema.Boolean,
  flagsAfterPositionals: Schema.Boolean,
});

const command = struct({
  ...base.fields,
  kind: Schema.Literal(NODE_KINDS[1]),
  key: Schema.String,
  out: outputSchema,
  argv: Schema.Array(valueSchema).pipe(Schema.mutable),
  flags: graphRecord(Schema.mutableKey(valueSchema)),
  flagSpec: Schema.optional(commandFlagSpecSchema),
  options: struct({
    cwd: Schema.NullOr(valueSchema),
    env: graphRecord(Schema.mutableKey(valueSchema)),
    stdin: Schema.NullOr(valueSchema),
    timeout: Schema.optional(durationSchema),
    maxOutputBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  rateLimit: Schema.NullOr(rateLimitSchema),
  retry: retrySchema,
  okExitCodes: Schema.Array(Schema.Int).pipe(Schema.mutable),
  parse: Schema.NullOr(
    struct({
      bundleHash: Schema.NullOr(Schema.String),
      input: graphRecord(Schema.mutableKey(valueSchema)),
    }),
  ),
});

const otherNodes = [
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[2]),
    predicate: predicateSchema,
    arms: struct({ yes: nodeIdSchema, no: nodeIdSchema }),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[3]),
    on: refSchema,
    cases: graphRecord(Schema.mutableKey(nodeIdSchema)),
    default: Schema.NullOr(nodeIdSchema),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[4]),
    over: refSchema,
    body: nodeIdSchema,
    item: refIdSchema,
    index: refIdSchema,
    concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
    onError: Schema.Literals(MAP_ERROR_MODES),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[5]),
    branches: graphRecord(Schema.mutableKey(nodeIdSchema)),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[6]),
    timeout: Schema.NullOr(durationSchema),
    payload: outputSchema,
  }),
  struct({ ...base.fields, kind: Schema.Literal(NODE_KINDS[7]), duration: durationSchema }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[8]),
    body: nodeIdSchema,
    cleanup: nodeIdSchema,
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[9]),
    body: nodeIdSchema,
    handler: nodeIdSchema,
    error: refIdSchema,
  }),
  struct({ ...base.fields, kind: Schema.Literal(NODE_KINDS[10]), message: valueSchema }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[11]),
    template: Schema.String,
    values: graphRecord(
      Schema.mutableKey(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, refSchema])),
    ),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[12]),
    message: valueSchema,
    data: Schema.NullOr(valueSchema),
  }),
  struct({ ...base.fields, kind: Schema.Literal(NODE_KINDS[13]) }),
  struct({ ...base.fields, kind: Schema.Literal(NODE_KINDS[14]) }),
  struct({ ...base.fields, kind: Schema.Literal(NODE_KINDS[15]) }),
  struct({
    ...base.fields,
    kind: Schema.Literal(NODE_KINDS[16]),
    result: Schema.Union([
      struct({ kind: Schema.Literal("value"), value: valueSchema }),
      struct({ kind: Schema.Literal("none") }),
    ]),
  }),
] as const;

export const nodeSchema = Schema.Union([code, command, ...otherNodes]);

export const nodeViewSchema = Schema.Union([
  struct({ ...code.fields, module: struct({ name: Schema.String }) }),
  struct({
    ...command.fields,
    parse: Schema.NullOr(struct({ input: graphRecord(Schema.mutableKey(valueSchema)) })),
  }),
  ...otherNodes,
]);
