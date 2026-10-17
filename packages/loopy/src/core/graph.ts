import type { Json } from "./model.js";

declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type NodeId = Brand<string, "NodeId">;

export type RefId = Brand<string, "RefId">;

export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

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

export type RecordSpec = Readonly<Record<string, (typeof FIELD_TYPES)[number]>>;

export type OutputSchema = RecordSpec | "json";

export type Ref = { ref: RefId; path: string[] };

export type Value = Json | Ref;

export type FormatOperand = string | number | boolean | Ref;

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
  backoff: (typeof RETRY_BACKOFFS)[number];
  retryOnExit: boolean;
};

export type CommandFlag = {
  readonly cli: string;
  readonly kind: "boolean" | "string" | "number";
  readonly repeatable?: boolean;
  readonly optionalValue?: boolean;
  readonly choices?: readonly string[];
  readonly supported?: boolean;
  readonly style?: "equals" | "space" | "attached" | "positional";
  readonly position?: "before" | "after";
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
          kind: (typeof NODE_KINDS)[0];
          in: Record<string, Value>;
          out: OutputSchema;
          module: { path: string; bundleHash: string | null };
          retry: GraphRetry;
          timeout: Duration | null;
        }
      | {
          kind: (typeof NODE_KINDS)[1];
          key: string;
          out: OutputSchema;
          argv: Value[];
          flags: Record<string, Value>;
          flagSpec?: CommandFlagSpec;
          options: { cwd: Value | null; env: Record<string, Value>; stdin: Value | null };
          retry: GraphRetry;
          okExitCodes: number[];
          parse: { bundleHash: string | null } | null;
        }
      | { kind: (typeof NODE_KINDS)[2]; predicate: Predicate; arms: { yes: NodeId; no: NodeId } }
      | {
          kind: (typeof NODE_KINDS)[3];
          on: Ref;
          cases: Record<string, NodeId>;
          default: NodeId | null;
        }
      | {
          kind: (typeof NODE_KINDS)[4];
          over: Ref;
          body: NodeId;
          item: RefId;
          index: RefId;
          concurrency: number;
          onError: (typeof MAP_ERROR_MODES)[number];
        }
      | { kind: (typeof NODE_KINDS)[5]; branches: Record<string, NodeId> }
      | { kind: (typeof NODE_KINDS)[6]; timeout: Duration | null; payload: OutputSchema }
      | { kind: (typeof NODE_KINDS)[7]; duration: Duration }
      | { kind: (typeof NODE_KINDS)[8]; body: NodeId; cleanup: NodeId }
      | { kind: (typeof NODE_KINDS)[9]; body: NodeId; handler: NodeId; error: RefId }
      | { kind: (typeof NODE_KINDS)[10]; message: Value }
      | { kind: (typeof NODE_KINDS)[11]; template: string; values: Record<string, FormatOperand> }
      | { kind: (typeof NODE_KINDS)[12]; message: Value; data: Value | null }
      | { kind: (typeof NODE_KINDS)[13] }
      | { kind: (typeof NODE_KINDS)[14] }
      | { kind: (typeof NODE_KINDS)[15] }
      // Joins make a scope's result explicit without inventing an executable callback.
      | { kind: (typeof NODE_KINDS)[16]; result: Value | null }
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

export const DIAGNOSTIC_CODES = [
  "duplicate_label",
  "inactive_builder",
  "duplicate_node",
  "duplicate_ref",
  "missing_endpoint",
  "missing_entry",
  "unresolved_ref",
  "out_of_scope_ref",
  "predicate_type",
  "invalid_size",
  "missing_arm",
  "invalid_scope",
  "cycle",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type Diagnostic = {
  code: DiagnosticCode;
  message: string;
  node: NodeId | null;
  source: { module: string; line: number; column: number } | null;
};

export type Graph = {
  version: 1;
  name: string;
  input: RecordSpec | "schema";
  nodes: Node[];
  edges: Edge[];
  entry: NodeId;
  outputs: Ref | null;
  warnings: Diagnostic[];
};

export type ExecutionKey = {
  runId: string;
  nodeId: NodeId;
  scope: { nodeId: NodeId; index: number }[];
};

export function executionKeyString(key: ExecutionKey): string {
  // JSON-quoted run/node ids and scope tuples are joined by '/'. Quoting keeps ids
  // unambiguous so stores and wire consumers share one execution identity.
  return [
    JSON.stringify(key.runId),
    JSON.stringify(key.nodeId),
    ...key.scope.map(({ nodeId, index }) => JSON.stringify([nodeId, index])),
  ].join("/");
}

export const NODE_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "retrying",
  "waiting",
  "sleeping",
  "cancelled",
] as const;

export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number];

export type NodeRun = Expand<
  {
    key: ExecutionKey;
    attempt: number;
    maxAttempts: number;
    startedAt: string;
  } & (
    | { status: (typeof NODE_RUN_STATUSES)[0] }
    | { status: (typeof NODE_RUN_STATUSES)[1]; output: Json; endedAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[2]; error: string; endedAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[3]; error: string; nextRetryAt: string; endedAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[4]; wakeAt: string | null }
    | { status: (typeof NODE_RUN_STATUSES)[5]; wakeAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[6]; endedAt: string }
  )
>;
