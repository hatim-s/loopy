import { Schema } from "effect";
import { positiveInt, struct } from "../codec";
import { durationSchema, positiveDurationSchema } from "../duration";
import { jsonSchema } from "../json";
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

export const commandFlagSpecSchema = struct({
  path: Schema.Array(Schema.String).pipe(Schema.mutable),
  flags: graphRecord(Schema.mutableKey(commandFlagSchema)),
  style: Schema.Literals(["equals", "space"]),
  positionalSeparator: Schema.Boolean,
  flagsAfterPositionals: Schema.Boolean,
});

export type CommandFlagSpec = Schema.Schema.Type<typeof commandFlagSpecSchema>;

export const COMMAND_PLATFORMS = ["darwin", "linux"] as const;

type CommandPlatform = (typeof COMMAND_PLATFORMS)[number];

/** A platform's program, flag rendering and preset flag values, which override the base values. */
const commandVariantSchema = struct({
  program: Schema.String,
  flagSpec: commandFlagSpecSchema,
  preset: graphRecord(Schema.mutableKey(jsonSchema)),
});

export type CommandVariant = Schema.Schema.Type<typeof commandVariantSchema>;

const platformVariant = Schema.optional(commandVariantSchema);

// The executing host picks its variant, so a graph saved on one platform runs on another.
export const commandVariantsSchema = struct({
  darwin: platformVariant,
  linux: platformVariant,
} satisfies Record<CommandPlatform, typeof platformVariant>);

export type CommandVariants = Schema.Schema.Type<typeof commandVariantsSchema>;

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
  timeout: Schema.NullOr(positiveDurationSchema),
});

export const commandNodeSchema = struct({
  ...base.fields,
  kind: Schema.Literal("command"),
  key: Schema.String,
  out: outputSchema,
  argv: Schema.Array(valueSchema).pipe(Schema.mutable),
  flags: values,
  // Only sh.exec and sh.run nodes, which pass argv through, have no flag spec.
  flagSpec: Schema.NullOr(commandFlagSpecSchema),
  variants: commandVariantsSchema,
  options: struct({
    cwd: Schema.NullOr(valueSchema),
    env: values,
    stdin: Schema.NullOr(valueSchema),
    timeout: Schema.NullOr(positiveDurationSchema),
    maxOutputBytes: Schema.NullOr(positiveInt),
  }),
  rateLimit: Schema.NullOr(rateLimitSchema),
  retry: retrySchema,
  okExitCodes: Schema.Array(Schema.Int).pipe(Schema.mutable),
  // A null parser module names the built-in parser for the command key.
  parse: Schema.NullOr(
    struct({
      module: Schema.NullOr(Schema.String),
      bundleHash: Schema.NullOr(Schema.String),
    }),
  ),
});

const MAP_ERROR_MODES = ["fail", "collect"] as const;

export const nodeSchema = Schema.Union([
  codeNodeSchema,
  commandNodeSchema,
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
]);

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
