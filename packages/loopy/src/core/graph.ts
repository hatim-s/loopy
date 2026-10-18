import type { Duration } from "./duration.js";
import type { InferRecord } from "./field-value.js";
import type { ExecutionMode, Json, Schedule } from "./model.js";
import type { RateLimit } from "./rate-limit.js";

declare const brand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type NodeId = Brand<string, "NodeId">;

export type RefId = Brand<string, "RefId">;

export function graphId<T extends NodeId | RefId>(value: string): T {
  // SAFETY: The builder constructs nonempty ids; wire ids are checked by the contract.
  return value as T;
}

export const SCALAR_TYPES = ["string", "number", "boolean"] as const;

export type ScalarType = (typeof SCALAR_TYPES)[number];

export const FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "json",
  "string[]",
  "number[]",
  "boolean[]",
  "json[]",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type ValueType = FieldType | "object" | "null" | "never";

export type RecordSpec = Readonly<Record<string, FieldType>>;

export const ERROR_FIELDS = {
  message: "string",
  code: "string",
  data: "json",
} as const satisfies RecordSpec;

export type OutSchema =
  | { kind: "record"; fields: RecordSpec }
  | { kind: "value"; type: FieldType }
  | null;

export const RAW_COMMAND_OUTPUT = {
  kind: "record",
  fields: { stdout: "string", stderr: "string", exitCode: "number" },
} as const;

export type Ref = { ref: RefId; path: string[] };

export type Value = Json | Ref;

type FormatOperand = string | number | boolean | Ref;

export const PREDICATE_SHAPES = {
  eq: "equality",
  ne: "equality",
  lt: "ordering",
  lte: "ordering",
  gt: "ordering",
  gte: "ordering",
  in: "membership",
  exists: "presence",
  isNull: "presence",
  and: "group",
  or: "group",
  not: "negation",
} as const;

type PredicateOp = keyof typeof PREDICATE_SHAPES;

type PredicateShape = (typeof PREDICATE_SHAPES)[PredicateOp];

type OpsOf<S extends PredicateShape> = {
  [K in PredicateOp]: (typeof PREDICATE_SHAPES)[K] extends S ? K : never;
}[PredicateOp];

export const PREDICATE_OPS = Object.keys(PREDICATE_SHAPES).filter((op): op is PredicateOp =>
  Object.hasOwn(PREDICATE_SHAPES, op),
);

export function predicateOps<S extends PredicateShape>(...shapes: S[]): OpsOf<S>[] {
  return PREDICATE_OPS.filter((op): op is OpsOf<S> =>
    shapes.some((shape) => shape === PREDICATE_SHAPES[op]),
  );
}

export const COMPARISON_OPS = predicateOps("equality", "ordering", "membership");

export type ComparisonOperand = Value | { ref: RefId; path: string[]; size: true };

export type Predicate =
  | {
      op: OpsOf<"equality" | "ordering" | "membership">;
      left: ComparisonOperand;
      right: ComparisonOperand;
    }
  | { op: OpsOf<"presence">; value: Value }
  | { op: OpsOf<"group">; predicates: Predicate[] }
  | { op: OpsOf<"negation">; predicate: Predicate };

export function predicateIs<S extends PredicateShape>(
  predicate: Predicate,
  shape: S,
): predicate is Predicate & { op: OpsOf<S> } {
  return PREDICATE_SHAPES[predicate.op] === shape;
}

export const NODE_KINDS = [
  "code",
  "command",
  "branch",
  "switch",
  "map",
  "parallel",
  "wait",
  "sleep",
  "finally",
  "rescue",
  "fail",
  "format",
  "log",
  "now",
  "uuid",
  "random",
  "join",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type Collected<T> =
  | { ok: true; value: T }
  | { ok: false; error: InferRecord<typeof ERROR_FIELDS> };

export const MAP_ERROR_MODES = ["fail", "collect"] as const;

export const RETRY_BACKOFFS = ["exponential"] as const;

export type GraphRetry = {
  attempts: number;
  backoff: "exponential";
  retryOnExit: boolean;
};

export const FLAG_KINDS = ["boolean", "string", "number"] as const;

export const FLAG_STYLES = [
  "equals",
  "space",
  "attached",
  "positional",
  "pairs",
  "terminated",
] as const;

export const FLAG_POSITIONS = ["before", "after"] as const;

export type FlagKind = (typeof FLAG_KINDS)[number];

export type FlagStyle = (typeof FLAG_STYLES)[number];

export type FlagPosition = (typeof FLAG_POSITIONS)[number];

type FlagOptions = {
  readonly cli: string;
  readonly supported?: boolean;
  readonly position?: FlagPosition;
  readonly order?: number;
  readonly prefix?: readonly string[];
};

type ScalarFlagOptions = {
  readonly style?: "space" | "equals" | "attached" | "positional";
  readonly repeatable?: true;
};

export type CommandFlag = Expand<
  FlagOptions &
    (
      | ({ readonly kind: "boolean" } & ScalarFlagOptions)
      | ({ readonly kind: "number"; readonly optionalValue?: true } & ScalarFlagOptions)
      | ({
          readonly kind: "string";
          readonly optionalValue?: true;
          readonly choices?: readonly string[];
        } & ScalarFlagOptions)
      | { readonly kind: "string"; readonly style: "pairs" }
      | { readonly kind: "string"; readonly style: "terminated"; readonly terminator: string }
    )
>;

export type CommandFlagSpec = {
  path: string[];
  flags: Record<string, CommandFlag>;
  style: "equals" | "space";
  positionalSeparator: boolean;
  flagsAfterPositionals: boolean;
};

type Expand<T> = T extends unknown ? { [K in keyof T]: T[K] } : never;

type NodeBase = {
  id: NodeId;
  label: string | null;
  // Scope preserves lexical visibility even when control flow has multiple predecessors.
  scope: NodeId | null;
};

export type Node = Expand<
  NodeBase &
    (
      | {
          kind: "code";
          in: Record<string, Value>;
          out: OutSchema;
          module: { path: string; bundleHash: string | null };
          rateLimit: RateLimit | null;
          retry: GraphRetry;
          timeout: Duration | null;
        }
      | {
          kind: "command";
          key: string;
          out: OutSchema;
          argv: Value[];
          flags: Record<string, Value>;
          flagSpec: CommandFlagSpec | null;
          options: { cwd: Value | null; env: Record<string, Value>; stdin: Value | null };
          rateLimit: RateLimit | null;
          retry: GraphRetry;
          okExitCodes: number[];
          parse: { bundleHash: string | null; input: Record<string, Value> } | null;
        }
      | { kind: "branch"; predicate: Predicate; arms: { yes: NodeId; no: NodeId } }
      | {
          kind: "switch";
          on: Ref;
          cases: Record<string, NodeId>;
          default: NodeId | null;
        }
      | {
          kind: "map";
          over: Ref;
          body: NodeId;
          item: RefId;
          index: RefId;
          concurrency: number;
          onError: "fail" | "collect";
        }
      | { kind: "parallel"; branches: Record<string, NodeId> }
      | { kind: "wait"; timeout: Duration | null; payload: OutSchema }
      | { kind: "sleep"; duration: Duration }
      | { kind: "finally"; body: NodeId; cleanup: NodeId }
      | { kind: "rescue"; body: NodeId; handler: NodeId; error: RefId }
      | { kind: "fail"; message: Value }
      | { kind: "format"; template: string; values: Record<string, FormatOperand> }
      | { kind: "log"; message: Value; data: Value | null }
      | { kind: "now" }
      | { kind: "uuid" }
      | { kind: "random" }
      // Joins make a scope's result explicit without inventing an executable callback.
      | {
          kind: "join";
          result: { kind: "value"; value: Value } | { kind: "none" };
        }
    )
>;

export const EDGE_KINDS = ["next", "join"] as const;

type EdgeKind = (typeof EDGE_KINDS)[number];

export type Edge = { from: NodeId; to: NodeId; kind: EdgeKind };

export const LOOPY_SCOPES = ["project", "global"] as const;

export type GraphMeta = {
  description: string | null;
  schedule: { cron: Schedule["cron"]; tz: Schedule["tz"] } | null;
  secrets: string[];
  mode: ExecutionMode;
  scope: (typeof LOOPY_SCOPES)[number];
};

export type Graph = {
  meta: GraphMeta;
  version: 1;
  name: string;
  input: RecordSpec;
  nodes: Node[];
  edges: Edge[];
  entry: NodeId;
  outputs: Ref | null;
};
