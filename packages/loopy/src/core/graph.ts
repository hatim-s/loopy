import type { Duration } from "./duration.js";
import type { ExecutionMode, Json, Schedule } from "./model.js";
import type { RateLimit } from "./rate-limit.js";

declare const brand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type NodeId = Brand<string, "NodeId">;

export type RefId = Brand<string, "RefId">;

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

export type OutSchema = { kind: "record"; fields: RecordSpec } | { kind: "value"; type: FieldType };

export type Ref = { ref: RefId; path: string[] };

export type Value = Json | Ref;

type FormatOperand = string | number | boolean | Ref;

export const PREDICATE_OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "exists",
  "isNull",
  "in",
  "and",
  "or",
  "not",
] as const;

export type PredicateOp = (typeof PREDICATE_OPS)[number];

export const COMPARISON_OPS = [
  PREDICATE_OPS[0],
  PREDICATE_OPS[1],
  PREDICATE_OPS[2],
  PREDICATE_OPS[3],
  PREDICATE_OPS[4],
  PREDICATE_OPS[5],
  PREDICATE_OPS[8],
] as const;

export type ComparisonOperand = Value | { ref: RefId; path: string[]; size: true };

export type Predicate =
  | { op: (typeof COMPARISON_OPS)[number]; left: ComparisonOperand; right: ComparisonOperand }
  | { op: (typeof PREDICATE_OPS)[6 | 7]; value: Value }
  | { op: (typeof PREDICATE_OPS)[9 | 10]; predicates: Predicate[] }
  | { op: (typeof PREDICATE_OPS)[11]; predicate: Predicate };

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

export const MAP_ERROR_MODES = ["fail", "collect"] as const;

export const RETRY_BACKOFFS = ["exponential"] as const;

export type GraphRetry = {
  attempts: number;
  backoff: "exponential";
  retryOnExit: boolean;
};

export const FLAG_KINDS = ["boolean", "string", "number"] as const;
export const FLAG_STYLES = ["equals", "space", "attached", "positional"] as const;
export const FLAG_POSITIONS = ["before", "after"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export type FlagStyle = (typeof FLAG_STYLES)[number];
export type FlagPosition = (typeof FLAG_POSITIONS)[number];

export type CommandFlag = {
  readonly cli: string;
  readonly kind: FlagKind;
  readonly repeatable?: boolean;
  readonly optionalValue?: boolean;
  readonly choices?: readonly string[];
  readonly supported?: boolean;
  readonly style?: FlagStyle;
  readonly position?: FlagPosition;
  readonly order?: number;
  readonly prefix?: readonly string[];
  readonly pairs?: boolean;
  readonly terminator?: string;
};

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

export const EDGE_KINDS = [
  "next",
  "yes",
  "no",
  "case",
  "each",
  "join",
  "cleanup",
  "rescue",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export type Edge = Expand<
  { from: NodeId; to: NodeId } & (
    | { kind: Exclude<EdgeKind, (typeof EDGE_KINDS)[3]> }
    | { kind: (typeof EDGE_KINDS)[3]; label: string }
  )
>;

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
