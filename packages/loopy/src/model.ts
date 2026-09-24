export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Reference<T = unknown> = {
  readonly $ref: { readonly source: "input" | "steps"; readonly path: readonly string[] };
  readonly __type?: T;
};
export type Expression<T = unknown> = {
  readonly $op:
    | "eq"
    | "ne"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "and"
    | "or"
    | "not"
    | "contains"
    | "concat";
  readonly args: readonly unknown[];
  readonly __type?: T;
};
export type Value<T> = T | Reference<T> | Expression<T>;
export type Command = {
  program: string;
  args: Value<string | number>[];
  stdin?: Value<string>;
  env?: Record<string, Value<string>>;
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
export type CommandNode = { id: string; kind: "command"; command: Command };
export type ConditionNode = {
  id: string;
  kind: "condition";
  test: Value<boolean>;
  then: WorkflowNode[];
  else: WorkflowNode[];
};
export type WorkflowNode = CommandNode | ConditionNode;
export type Workflow = { version: 1; slug: string; description?: string; nodes: WorkflowNode[] };
export type ExecutionMode = "sandbox" | "full";
export type RunOptions = { cwd: string; mode: ExecutionMode };
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted";
export type RunRecord = {
  id: string;
  slug: string;
  workflow: Workflow;
  workflowHash: string;
  input: Json;
  options: RunOptions;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
};
export type AttemptRecord = {
  id: string;
  runId: string;
  nodeId: string;
  number: number;
  status: "running" | "succeeded" | "failed" | "uncertain";
  input: Json;
  output?: Json;
  error?: string;
  startedAt: string;
  endedAt?: string;
};
export type RunEvent = {
  sequence: number;
  runId: string;
  nodeId?: string;
  type: string;
  data: Json;
  createdAt: string;
};
export type ResolvedCommand = Omit<Command, "args" | "stdin" | "env"> & {
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
};
export type ExecuteCommand = (
  command: ResolvedCommand,
  options: RunOptions & { signal?: AbortSignal },
) => Promise<CommandOutput>;
