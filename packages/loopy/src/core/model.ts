export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ExecutionMode = "sandbox" | "full";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export type RunStatus = "queued" | "running" | "suspended" | "succeeded" | "failed" | "cancelled";

export type StepKind = "command" | "function" | "sleep" | "hook" | "clock" | "random";

export type LogLevel = "info" | "warn" | "error";

type RunOwner = { token: string; pid: number; host: string; heartbeatAt: string };

export type RunOutcome =
  | { status: "succeeded"; output: Json }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export type RunRecord = {
  id: string;
  slug: string;
  bundleHash: string;
  workspace: string;
  input: Json;
  status: RunStatus;
  output?: Json;
  error?: string;
  wakeAt?: string;
  createdAt: string;
  updatedAt: string;
  owner?: RunOwner;
};

export type StepBase = {
  runId: string;
  seq: number;
  key: string;
  kind: StepKind;
  input: Json;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
};

export type StepRecord = StepBase &
  (
    | { status: "running" }
    | { status: "succeeded"; output: Json; endedAt: string; finishOrder: number }
    | { status: "failed"; error: string; endedAt: string; finishOrder: number }
    | { status: "retrying"; error: string; nextRetryAt: string; endedAt: string }
    | { status: "sleeping"; wakeAt: string }
    | { status: "waiting"; wakeAt?: string }
  );

export type WaitingHookStep = Omit<StepBase, "input" | "kind"> & {
  kind: "hook";
  status: "waiting";
  input: { name: string; token: string };
  wakeAt?: string;
};

export type HookRecord = {
  token: string;
  runId: string;
  seq: number;
  name: string;
  createdAt: string;
  payload?: Json;
  resolvedAt?: string;
  expiredAt?: string;
};

export type LogPosition =
  | { kind: "workflow"; afterStep: number; afterFinish: number; index: number }
  | { kind: "step"; seq: number; attempt: number; index: number };

export type LogRecord = {
  runId: string;
  seq: number;
  position: LogPosition;
  level: LogLevel;
  message: string;
  data?: Json;
  at: string;
};

export type Schedule = {
  workspace: string;
  slug: string;
  cron: string;
  tz: string;
  input: Json;
  enabled: boolean;
  lastFireKey?: string;
  nextFireAt: string;
};

export type RunSnapshot = {
  run: RunRecord;
  steps: StepRecord[];
  logs: LogRecord[];
  hooks: HookRecord[];
  cursor: number;
  epoch: string;
};

export type RunDetail = { run: RunRecord; steps: StepRecord[]; logs: LogRecord[] };

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.some((terminal) => terminal === status);
}

export type LoopySummary = {
  slug: string;
  description?: string;
  scope: "project" | "global";
  schedule?: { cron: string; tz?: string };
};

export const RUN_EVENT_KINDS = [
  "created",
  "claimed",
  "heartbeat",
  "suspended",
  "woken",
  "released",
  "finished",
] as const;

export const STEP_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "retrying",
  "sleeping",
  "waiting",
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
  | Event<"step", StepRecord["status"], StepRecord>
  | Event<"log", "written", LogRecord>
  | Event<"hook", (typeof HOOK_EVENT_KINDS)[number], HookRecord>
  | Event<"schedule", (typeof SCHEDULE_EVENT_KINDS)[number], Schedule>
  | Event<"schedule", "deleted", { workspace: string; slug: string }>;

export type RuntimeEventChange<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, "sequence" | "at" | "txn">
  : never;
