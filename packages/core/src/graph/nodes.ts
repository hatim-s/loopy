import { Schema } from "effect";
import { positiveInt, struct } from "../codec";
import { durationSchema } from "../duration";
import { rateLimitSchema } from "../rate-limit";
import {
  formatOperandSchema,
  graphRecord,
  labelSchema,
  nodeIdSchema,
  type OutSchema,
  outputSchema,
  predicateSchema,
  refIdSchema,
  refSchema,
  valueSchema,
} from "./values";

const retrySchema = struct({ attempts: positiveInt, retryOnExit: Schema.Boolean });

export type GraphRetry = Schema.Schema.Type<typeof retrySchema>;

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

export type CommandFlag = Schema.Schema.Type<typeof commandFlagSchema>;

const commandFlagSpecSchema = struct({
  path: Schema.Array(Schema.String).pipe(Schema.mutable),
  flags: graphRecord(Schema.mutableKey(commandFlagSchema)),
  style: Schema.Literals(["equals", "space"]),
  positionalSeparator: Schema.Boolean,
  flagsAfterPositionals: Schema.Boolean,
});

export type CommandFlagSpec = Schema.Schema.Type<typeof commandFlagSpecSchema>;

const values = graphRecord(Schema.mutableKey(valueSchema));

const children = graphRecord(Schema.mutableKey(nodeIdSchema));

const base = struct({
  id: nodeIdSchema,
  label: Schema.NullOr(labelSchema),
  // Scope preserves lexical visibility even when control flow has multiple predecessors.
  scope: Schema.NullOr(nodeIdSchema),
});

export const codeNodeSchema = struct({
  ...base.fields,
  kind: Schema.Literal("code"),
  in: values,
  out: outputSchema,
  module: struct({ path: Schema.String, bundleHash: Schema.NullOr(Schema.String) }),
  rateLimit: Schema.NullOr(rateLimitSchema),
  retry: retrySchema,
  timeout: Schema.NullOr(durationSchema),
});

export const commandNodeSchema = struct({
  ...base.fields,
  kind: Schema.Literal("command"),
  key: Schema.String,
  out: outputSchema,
  argv: Schema.Array(valueSchema).pipe(Schema.mutable),
  flags: values,
  flagSpec: Schema.optional(commandFlagSpecSchema),
  options: struct({
    cwd: Schema.NullOr(valueSchema),
    env: values,
    stdin: Schema.NullOr(valueSchema),
    timeout: Schema.optional(durationSchema),
    maxOutputBytes: Schema.optional(positiveInt),
  }),
  rateLimit: Schema.NullOr(rateLimitSchema),
  retry: retrySchema,
  okExitCodes: Schema.Array(Schema.Int).pipe(Schema.mutable),
  parse: Schema.NullOr(struct({ bundleHash: Schema.NullOr(Schema.String), input: values })),
});

export const MAP_ERROR_MODES = ["fail", "collect"] as const;

// Control and value nodes need no executor, so their wire views equal their stored shape.
export const otherNodeSchemas = [
  struct({
    ...base.fields,
    kind: Schema.Literal("branch"),
    predicate: predicateSchema,
    arms: struct({ yes: nodeIdSchema, no: nodeIdSchema }),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal("switch"),
    on: refSchema,
    cases: children,
    default: Schema.NullOr(nodeIdSchema),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal("map"),
    over: refSchema,
    body: nodeIdSchema,
    item: refIdSchema,
    index: refIdSchema,
    concurrency: positiveInt,
    onError: Schema.Literals(MAP_ERROR_MODES),
  }),
  struct({ ...base.fields, kind: Schema.Literal("parallel"), branches: children }),
  struct({
    ...base.fields,
    kind: Schema.Literal("wait"),
    timeout: Schema.NullOr(durationSchema),
    payload: outputSchema,
  }),
  struct({ ...base.fields, kind: Schema.Literal("sleep"), duration: durationSchema }),
  struct({
    ...base.fields,
    kind: Schema.Literal("finally"),
    body: nodeIdSchema,
    cleanup: nodeIdSchema,
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal("rescue"),
    body: nodeIdSchema,
    handler: nodeIdSchema,
    error: refIdSchema,
  }),
  struct({ ...base.fields, kind: Schema.Literal("fail"), message: valueSchema }),
  struct({
    ...base.fields,
    kind: Schema.Literal("format"),
    template: Schema.String,
    values: graphRecord(Schema.mutableKey(formatOperandSchema)),
  }),
  struct({
    ...base.fields,
    kind: Schema.Literal("log"),
    message: valueSchema,
    data: Schema.NullOr(valueSchema),
  }),
  struct({ ...base.fields, kind: Schema.Literal("now") }),
  struct({ ...base.fields, kind: Schema.Literal("uuid") }),
  struct({ ...base.fields, kind: Schema.Literal("random") }),
  // Joins make a scope's result explicit without inventing an executable callback.
  struct({
    ...base.fields,
    kind: Schema.Literal("join"),
    result: Schema.Union([
      struct({ kind: Schema.Literal("value"), value: valueSchema }),
      struct({ kind: Schema.Literal("none") }),
    ]),
  }),
] as const;

export const nodeSchema = Schema.Union([codeNodeSchema, commandNodeSchema, ...otherNodeSchemas]);

export type Node = Schema.Schema.Type<typeof nodeSchema>;

export type ExecutableNode = Extract<Node, { kind: "code" | "command" }>;

export function isExecutable(node: Node): node is ExecutableNode {
  return node.kind === "code" || node.kind === "command";
}

export function declaredOutput(node: Node): OutSchema | null {
  switch (node.kind) {
    case "code":
    case "command":
      return node.out;
    case "wait":
      return node.payload;
    default:
      return null;
  }
}
