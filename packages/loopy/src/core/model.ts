export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Scalar = null | boolean | number | string;

export type ReferenceSource = "input" | "steps";

export type Reference<T = unknown> = {
  readonly $ref: { readonly source: ReferenceSource; readonly path: readonly string[] };
  readonly __type?: T;
};

export type Operator =
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

export type Expression<T = unknown> = {
  readonly $op: Operator;
  readonly args: readonly unknown[];
  readonly __type?: T;
};

export type FilePath = { readonly $file: string };

export type Value<T> = T | Reference<T> | Expression<T> | (T extends string ? FilePath : never);

/** A check applied to one resolved argv entry before the command launches. */
export type ArgConstraint = { kind: "string" | "number"; choices?: string[]; prefix?: string };

export type Command = {
  program: string;
  args: Value<string | number>[];
  argConstraints?: Record<number, ArgConstraint>;
  stdin?: Value<string>;
  env?: Record<string, Value<string>>;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type ResolvedCommand = Omit<Command, "args" | "stdin" | "env"> & {
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
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

export type WorkflowConfig = { scope: "project" | "global" };

export type Workflow = {
  version: 1;
  slug: string;
  description?: string;
  config?: WorkflowConfig;
  nodes: WorkflowNode[];
};

export type ExecutionMode = "sandbox" | "full";

export type Workspace = { kind: "local"; path: string } | { kind: "managed"; id: string };

/** References only. Values are loaded by the local adapter at command launch. */
export type SecretBindings = { ownerId: string; env: Record<string, string> };

export type RunOptions = {
  workspace: Workspace;
  mode: ExecutionMode;
  secretBindings?: SecretBindings;
};

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

export type AttemptStatus = "running" | "succeeded" | "failed" | "uncertain" | "cancelled";

export type AttemptRecord = {
  id: string;
  runId: string;
  nodeId: string;
  number: number;
  status: AttemptStatus;
  input: Json;
  output?: Json;
  error?: string;
  startedAt: string;
  endedAt?: string;
};

/** Every event the stores emit. Run status changes map one to one. */
export type RunEventType =
  | "run.created"
  | "run.started"
  | "run.resumed"
  | "run.owner_recovered"
  | `run.${RunStatus}`
  | "node.started"
  | `node.${Exclude<AttemptStatus, "running">}`;

export type RunEvent = {
  sequence: number;
  runId: string;
  nodeId?: string;
  type: RunEventType;
  data: Json;
  createdAt: string;
};

/** One row of a saved-workflow listing, shared by the registry, the HTTP API and Studio. */
export type WorkflowSummary = {
  slug: string;
  description?: string;
  scope: "project" | "global";
  nodeCount: number;
  updatedAt: string;
  source: string;
};

export type ExecuteCommand = (
  command: ResolvedCommand,
  options: RunOptions & {
    runId: string;
    nodeId: string;
    attemptId: string;
    ownerToken: string;
    signal?: AbortSignal;
  },
) => Promise<CommandOutput>;

export type RunDetail = { run: RunRecord; attempts: AttemptRecord[]; events: RunEvent[] };
