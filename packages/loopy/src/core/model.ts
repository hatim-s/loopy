export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ExecutionMode = "sandbox" | "full";

export type Workspace = { kind: "local"; path: string };

export type RunOptions = { workspace: Workspace; mode: ExecutionMode };

export type ResolvedCommand = {
  program: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export type EngineRunStatus =
  | "queued"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StepKind = "command" | "function" | "sleep" | "hook" | "clock" | "random";

export type LogLevel = "info" | "warn" | "error";

export type RunOwner = { token: string; pid: number; host: string; heartbeatAt: string };

export type RunOutcome =
  | { status: "succeeded"; output: Json }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export type EngineRun = {
  id: string;
  slug: string;
  bundleHash: string;
  workspace: string;
  input: Json;
  status: EngineRunStatus;
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

export type EngineStep = StepBase &
  (
    | { status: "running" }
    | { status: "succeeded"; output: Json; endedAt: string; finishOrder: number }
    | { status: "failed"; error: string; endedAt: string; finishOrder: number }
    | { status: "retrying"; error: string; nextRetryAt: string; endedAt: string }
    | { status: "sleeping"; wakeAt: string }
  );

export type StepStatus = EngineStep["status"];

export type LogPosition =
  | { kind: "workflow"; afterStep: number; afterFinish: number; index: number }
  | { kind: "step"; seq: number; attempt: number; index: number };

export type EngineLog = {
  runId: string;
  seq: number;
  position: LogPosition;
  level: LogLevel;
  message: string;
  data?: Json;
  at: string;
};

export type CommandResult = CommandOutput;

export type Schedule = {
  slug: string;
  cron: string;
  tz: string;
  input: Json;
  enabled: boolean;
  lastFireKey?: string;
  nextFireAt: string;
};

export type EngineRunDetail = { run: EngineRun; steps: EngineStep[]; logs: EngineLog[] };

export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly EngineRunStatus[];

export function isTerminalRun(status: EngineRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.some((terminal) => terminal === status);
}
