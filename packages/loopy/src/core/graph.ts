import type { ExecutionError } from "./executor.js";
import type { ExecutionMode, Json, Schedule } from "./model.js";
import type { RateLimit } from "./rate-limit.js";

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

export type FieldType = (typeof FIELD_TYPES)[number];

export type RecordSpec = Readonly<Record<string, FieldType>>;

export const ERROR_FIELDS = {
  message: "string",
  code: "string",
  data: "json",
} as const satisfies RecordSpec;

export type OutSchema = { kind: "record"; fields: RecordSpec } | { kind: "value"; type: FieldType };

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
          out: OutSchema;
          module: { path: string; bundleHash: string | null };
          rateLimit: RateLimit | null;
          retry: GraphRetry;
          timeout: Duration | null;
        }
      | {
          kind: (typeof NODE_KINDS)[1];
          key: string;
          out: OutSchema;
          argv: Value[];
          flags: Record<string, Value>;
          flagSpec?: CommandFlagSpec;
          options: {
            cwd: Value | null;
            env: Record<string, Value>;
            stdin: Value | null;
            timeout?: Duration;
            maxOutputBytes?: number;
          };
          rateLimit: RateLimit | null;
          retry: GraphRetry;
          okExitCodes: number[];
          parse: { bundleHash: string | null; input: Record<string, Value> } | null;
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
      | { kind: (typeof NODE_KINDS)[6]; timeout: Duration | null; payload: OutSchema }
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
      | {
          kind: (typeof NODE_KINDS)[16];
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

export const LOOPY_SCOPES = ["project", "global"] as const;

export type GraphMeta = {
  description: string | null;
  schedule: { cron: Schedule["cron"]; tz?: Schedule["tz"] } | null;
  secrets: string[];
  mode: ExecutionMode;
  scope: (typeof LOOPY_SCOPES)[number];
};

export type InputValidation = {
  minItems: Readonly<Record<string, number>>;
  unknownKeys: "strip" | "reject" | "passthrough";
  root?: "json";
};

export type Graph = {
  meta: GraphMeta;
  version: 1;
  name: string;
  input: RecordSpec | "schema";
  inputValidation?: InputValidation;
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
  "queued",
  "skipped",
  "rate_limited",
] as const;

export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number];

export const RECEIPT_KINDS = ["none", "started", "finished"] as const;

export type NodeRun = Expand<
  {
    key: ExecutionKey;
    attempt: number;
    maxAttempts: number;
    startedAt: string;
    receipt: (typeof RECEIPT_KINDS)[number];
  } & (
    | { status: (typeof NODE_RUN_STATUSES)[0] }
    | { status: (typeof NODE_RUN_STATUSES)[7] }
    | { status: (typeof NODE_RUN_STATUSES)[9]; nextRetryAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[1]; output: Json; endedAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[2]; error: ExecutionError; endedAt: string }
    | {
        status: (typeof NODE_RUN_STATUSES)[3];
        error: ExecutionError;
        nextRetryAt: string;
        endedAt: string;
      }
    | { status: (typeof NODE_RUN_STATUSES)[4]; wakeAt: string | null }
    | { status: (typeof NODE_RUN_STATUSES)[5]; wakeAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[6]; endedAt: string }
    | { status: (typeof NODE_RUN_STATUSES)[8]; endedAt: string }
  )
>;

export const COMPILER_DIAGNOSTIC_CODES = [
  "dynamic_code",
  "options_not_literal",
  "unknown_sdk_call",
  "default_loopy",
  "source_error",
  "evaluation_failed",
  "bundle_failed",
  "syntax_error",
  "literal_required",
  "synchronous_run",
  "invalid_binding",
  "literal_key",
  "module_path",
  "module_default",
  "invalid_callback",
  "forbidden_call",
  "forbidden_expression",
  "invalid_reference",
  "await_forbidden",
  "template_reference",
  "forbidden_statement",
  "command_descriptor",
  "command_key",
  "module_import",
  "cyclic_import",
  "sdk_alias",
  "module_effect",
] as const;

export type CompilerDiagnosticCode = (typeof COMPILER_DIAGNOSTIC_CODES)[number] | DiagnosticCode;
