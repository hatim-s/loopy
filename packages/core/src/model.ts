import { Schema } from "effect";
import { counter, struct } from "./codec";
import type { NodeRun } from "./graph/node-run";
import { jsonSchema } from "./json";

export const EXECUTION_MODES = ["sandbox", "full"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export const RUN_STATUSES = [
  "queued",
  "running",
  "suspended",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const runStatusSchema = Schema.Literals(RUN_STATUSES);

export type RunStatus = Schema.Schema.Type<typeof runStatusSchema>;

export function emptyRunCounts(): Record<RunStatus, number> {
  return { queued: 0, running: 0, suspended: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

export const runOutcomeSchema = Schema.Union([
  struct({ status: Schema.Literal("succeeded"), output: jsonSchema }),
  struct({ status: Schema.Literal("failed"), error: Schema.String }),
  struct({ status: Schema.Literal("cancelled") }),
]);

export type RunOutcome = Schema.Schema.Type<typeof runOutcomeSchema>;

export const runRecordSchema = struct({
  id: Schema.String,
  slug: Schema.String,
  revision: Schema.String,
  workspace: Schema.String,
  input: jsonSchema,
  status: runStatusSchema,
  output: Schema.optional(jsonSchema),
  error: Schema.optional(Schema.String),
  wakeAt: Schema.optional(Schema.String),
  nextRetryAt: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  owner: Schema.optional(
    struct({
      token: Schema.String,
      pid: Schema.NullOr(Schema.Int),
      host: Schema.String,
      heartbeatAt: Schema.String,
    }),
  ),
  truncatedFields: Schema.optional(
    struct({ input: Schema.optional(counter), output: Schema.optional(counter) }),
  ),
});

export type RunRecord = Schema.Schema.Type<typeof runRecordSchema>;

export const LOG_LEVELS = ["info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const logPositionSchema = struct({
  kind: Schema.Literal("node"),
  executionKey: Schema.String,
  attempt: counter,
  index: counter,
});

export type LogPosition = Schema.Schema.Type<typeof logPositionSchema>;

export const logRecordSchema = struct({
  runId: Schema.String,
  seq: counter,
  position: logPositionSchema,
  level: Schema.Literals(LOG_LEVELS),
  message: Schema.String,
  data: Schema.optional(jsonSchema),
  at: Schema.String,
});

export type LogRecord = Schema.Schema.Type<typeof logRecordSchema>;

export const hookRecordSchema = struct({
  token: Schema.String,
  runId: Schema.String,
  seq: counter,
  name: Schema.String,
  createdAt: Schema.String,
  payload: Schema.optional(jsonSchema),
  resolvedAt: Schema.optional(Schema.String),
  expiredAt: Schema.optional(Schema.String),
});

export type HookRecord = Schema.Schema.Type<typeof hookRecordSchema>;

export type PendingHook = HookRecord & { expiresAt: string | null };

export const scheduleSchema = struct({
  version: Schema.Int,
  workspace: Schema.String,
  slug: Schema.String,
  cron: Schema.String,
  tz: Schema.String,
  input: jsonSchema,
  enabled: Schema.Boolean,
  lastFireKey: Schema.optional(Schema.String),
  nextFireAt: Schema.String,
});

export type Schedule = Schema.Schema.Type<typeof scheduleSchema>;

export type RunSnapshot = {
  run: RunRecord;
  nodeRuns: NodeRun[];
  logs: LogRecord[];
  hooks: HookRecord[];
  cursor: number;
  epoch: string;
};

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.some((terminal) => terminal === status);
}

export const RUN_EVENT_KINDS = [
  "created",
  "claimed",
  "heartbeat",
  "suspended",
  "woken",
  "released",
  "finished",
] as const;

export const HOOK_EVENT_KINDS = ["created", "resolved", "expired"] as const;

export const SCHEDULE_EVENT_KINDS = ["saved", "fired"] as const;

type Event<E extends string, K extends string, R> = {
  sequence: number;
  at: string;
  txn: string;
  entity: E;
  kind: K;
  runId: string | null;
  record: R;
};

export type RuntimeEvent =
  | Event<"run", (typeof RUN_EVENT_KINDS)[number], RunRecord>
  | Event<"node", NodeRun["status"], NodeRun>
  | Event<"log", "written", LogRecord>
  | Event<"hook", (typeof HOOK_EVENT_KINDS)[number], HookRecord>
  | Event<"schedule", (typeof SCHEDULE_EVENT_KINDS)[number], Schedule>
  | Event<"schedule", "deleted", { workspace: string; slug: string }>;

export const RUNTIME_EVENT_ENTITIES = [
  "run",
  "node",
  "log",
  "hook",
  "schedule",
] as const satisfies readonly RuntimeEvent["entity"][];

export type RuntimeEventChange<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, "sequence" | "at" | "txn">
  : never;
