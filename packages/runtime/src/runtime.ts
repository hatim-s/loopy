import type {
  ExecutionPlan,
  JsonObject,
  JsonValue,
  Predicate,
  ValueReference,
  WorkflowDefinition,
  WorkflowEdge,
} from "@loopy/contracts";

export type { JsonObject, JsonValue } from "@loopy/contracts";

export type RunStatus =
  | "created"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed";
export type AttemptStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type RuntimeNode = {
  id: string;
  name?: string;
  kind: string;
  [key: string]: unknown;
};
export type RuntimeEdge = WorkflowEdge & { [key: string]: unknown };
export type RuntimePlan = {
  workflowId: string;
  workflowVersion: number;
  nodes: RuntimeNode[];
  edges: RuntimeEdge[];
  topology?: { startNodeIds?: string[]; terminalNodeIds?: string[]; topologicalOrder?: string[] };
  policies?: { concurrency?: { maxParallel?: number }; budget?: { timeoutMs?: number } };
  defaults?: { provider?: string; retry?: RetryPolicy };
  [key: string]: unknown;
};
export type RuntimePlanInput = Omit<RuntimePlan, "workflowId" | "nodes" | "edges"> & {
  workflowId?: string;
  id?: string;
  nodes: Array<RuntimeNode | Record<string, unknown>>;
  edges: Array<RuntimeEdge | Record<string, unknown>>;
};

export type RetryPolicy = {
  maxAttempts?: number;
  retryOn?: string[];
  backoffMs?: number;
};
export type Completion = {
  status: "succeeded" | "failed" | "cancelled" | "skipped";
  summary: string;
  outputs: JsonObject;
  route?: string;
  verification?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type RunRecord = {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  plan: RuntimePlan;
  inputs: JsonObject;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
};
export type AttemptRecord = {
  attemptId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: AttemptStatus;
  input: JsonObject;
  output?: JsonObject;
  completion?: Completion;
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
};
export type ApprovalRecord = {
  runId: string;
  nodeId: string;
  attemptId: string;
  key: string;
  message: string;
  decision?: "approved" | "rejected";
};
export type RuntimeEvent = {
  sequence: number;
  type: string;
  runId: string;
  nodeId?: string;
  attemptId?: string;
  payload?: Record<string, unknown>;
  occurredAt: string;
};

/** Commands are intents, not a persistence implementation. A SQLite adapter can commit a batch atomically. */
export type RuntimeStoreCommand =
  | { type: "create_run"; run: RunRecord }
  | { type: "set_run"; runId: string; patch: Partial<RunRecord> }
  | { type: "create_attempt"; attempt: AttemptRecord }
  | { type: "set_attempt"; attemptId: string; patch: Partial<AttemptRecord> }
  | { type: "set_approval"; approval: ApprovalRecord }
  | { type: "resolve_approval"; runId: string; nodeId: string; decision: "approved" | "rejected" }
  | { type: "append_event"; event: RuntimeEvent };

export interface RuntimeStore {
  /** Implementations must apply all commands in one transaction. */
  commit(commands: readonly RuntimeStoreCommand[]): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>;
  listAttempts(runId: string): Promise<AttemptRecord[]>;
  listEvents(runId: string): Promise<RuntimeEvent[]>;
  getApproval(runId: string, nodeId: string): Promise<ApprovalRecord | undefined>;
}

export type ProviderExecutionContext = {
  runId: string;
  attemptId: string;
  nodeId: string;
  node: RuntimeNode;
  input: JsonObject;
  signal: AbortSignal;
};
export type ProviderResult =
  | { status: "succeeded"; outputs?: JsonObject; summary?: string; route?: string; error?: string }
  | {
      status: "failed" | "cancelled";
      error?: string;
      outputs?: JsonObject;
      summary?: string;
      route?: string;
    };
export interface ProviderExecutor {
  execute(context: ProviderExecutionContext): Promise<ProviderResult>;
  cancel?(attemptId: string): Promise<void> | void;
}
export type VerificationContext = {
  runId: string;
  attemptId: string;
  nodeId: string;
  node: RuntimeNode;
  input: JsonObject;
};
export type VerificationResult = {
  status: "passed" | "failed";
  summary?: string;
  details?: JsonObject;
};
export interface VerificationExecutor {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export type RuntimeSnapshot = {
  run: RunRecord;
  attempts: AttemptRecord[];
  events: RuntimeEvent[];
  approvals: ApprovalRecord[];
};
export type RuntimeOptions = {
  store: RuntimeStore;
  provider: ProviderExecutor;
  verifier?: VerificationExecutor;
  now?: () => string;
  id?: () => string;
};

const TERMINAL_ATTEMPTS = new Set<AttemptStatus>(["succeeded", "failed", "cancelled", "skipped"]);
const TERMINAL_RUNS = new Set<RunStatus>(["cancelled", "succeeded", "failed"]);

function idFallback(prefix: string): string {
  // UUIDs keep the runtime compatible with the persisted contracts while still
  // being usable with deliberately small test workflows.
  const seed = `${prefix}-${Date.now()}-${Math.random()}`;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${hex}${hex.slice(0, 4)}-4000-8000-0000-${hex}${hex}${hex.slice(0, 4)}`.slice(0, 36);
}
function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function config(node: RuntimeNode, key: string): unknown {
  if (node[key] !== undefined) return node[key];
  const nested = node.configuration;
  return typeof nested === "object" && nested !== null
    ? (nested as Record<string, unknown>)[key]
    : undefined;
}
function refValue(
  ref: ValueReference | Record<string, unknown>,
  run: RunRecord,
  attempts: AttemptRecord[],
): unknown {
  const kind = ref.kind;
  if (kind === "literal") return ref.value;
  if (kind === "workflow_input") return run.inputs[String(ref.name)];
  if (kind === "node_output") {
    const source = attempts
      .filter((attempt) => attempt.nodeId === ref.nodeId && attempt.status === "succeeded")
      .sort((a, b) => b.attempt - a.attempt)[0];
    return valueAt(source?.output, Array.isArray(ref.path) ? ref.path.map(String) : []);
  }
  return undefined;
}
function predicateValue(
  value: Record<string, unknown>,
  run: RunRecord,
  attempts: AttemptRecord[],
): unknown {
  if (value.kind === "reference")
    return refValue(value.reference as Record<string, unknown>, run, attempts);
  return value.value;
}
function evaluatePredicate(
  predicate: Predicate | Record<string, unknown>,
  run: RunRecord,
  attempts: AttemptRecord[],
): boolean {
  const p = predicate as Record<string, unknown>;
  if (p.kind === "boolean") {
    const values = (p.operands as Array<Record<string, unknown>>).map((item) =>
      evaluatePredicate(item, run, attempts),
    );
    return p.operator === "and" ? values.every(Boolean) : values.some(Boolean);
  }
  if (p.kind === "not")
    return !evaluatePredicate(p.operand as Record<string, unknown>, run, attempts);
  if (p.kind !== "comparison") return false;
  const left = predicateValue(p.left as Record<string, unknown>, run, attempts);
  const right = predicateValue(p.right as Record<string, unknown>, run, attempts);
  switch (p.operator) {
    case "equals":
      return Object.is(left, right);
    case "not_equals":
      return !Object.is(left, right);
    case "less_than":
      return typeof left === "number" && typeof right === "number" && left < right;
    case "less_than_or_equal":
      return typeof left === "number" && typeof right === "number" && left <= right;
    case "greater_than":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "greater_than_or_equal":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "contains":
      return Array.isArray(left)
        ? left.includes(right as never)
        : typeof left === "string" && typeof right === "string" && left.includes(right);
    default:
      return false;
  }
}

function normalizePlan(
  input: RuntimePlan | RuntimePlanInput | WorkflowDefinition | ExecutionPlan,
): RuntimePlan {
  const source = input as RuntimePlan & {
    id?: string;
    workflowId?: string;
    topology?: RuntimePlan["topology"];
  };
  const nodes = (source.nodes as unknown as Array<Record<string, unknown>>).map((node) => ({
    ...node,
    id: String(node.id ?? node.nodeId),
    kind: String(node.kind),
  })) as RuntimeNode[];
  return {
    ...source,
    workflowId: String(source.workflowId ?? source.id ?? "workflow"),
    workflowVersion: Number(source.workflowVersion ?? 1),
    nodes,
    edges: (source.edges ?? []) as RuntimeEdge[],
  };
}

export class RuntimeScheduler {
  private readonly options: RuntimeOptions;
  private readonly active = new Map<string, Set<string>>();
  private readonly activeNodes = new Map<string, Map<string, string>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pumping = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly sequences = new Map<string, number>();
  private readonly retrying = new Map<string, Promise<AttemptRecord>>();

  constructor(options: RuntimeOptions) {
    this.options = options;
  }
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private makeId(prefix: string): string {
    return this.options.id?.() ?? idFallback(prefix);
  }
  private async event(
    runId: string,
    type: string,
    nodeId?: string,
    attemptId?: string,
    payload?: Record<string, unknown>,
  ): Promise<RuntimeStoreCommand> {
    const events = await this.options.store.listEvents(runId);
    const sequence = this.sequences.has(runId)
      ? (this.sequences.get(runId) as number)
      : events.length;
    this.sequences.set(runId, sequence + 1);
    return {
      type: "append_event",
      event: {
        sequence,
        type,
        runId,
        nodeId,
        attemptId,
        payload,
        occurredAt: this.now(),
      },
    };
  }
  async start(
    planInput: RuntimePlan | RuntimePlanInput | WorkflowDefinition | ExecutionPlan,
    inputs: JsonObject = {},
  ): Promise<RunRecord> {
    const plan = normalizePlan(planInput);
    const run: RunRecord = {
      runId: this.makeId("run"),
      workflowId: plan.workflowId,
      workflowVersion: plan.workflowVersion,
      plan,
      inputs,
      status: "created",
      createdAt: this.now(),
    };
    await this.options.store.commit([
      { type: "create_run", run },
      await this.event(run.runId, "run.created"),
    ]);
    await this.options.store.commit([
      { type: "set_run", runId: run.runId, patch: { status: "running", startedAt: this.now() } },
      await this.event(run.runId, "run.started"),
    ]);
    void this.pump(run.runId);
    return (await this.options.store.getRun(run.runId)) as RunRecord;
  }
  async run(
    plan: RuntimePlan | RuntimePlanInput | WorkflowDefinition | ExecutionPlan,
    inputs: JsonObject = {},
  ): Promise<RuntimeSnapshot> {
    const started = await this.start(plan, inputs);
    return this.wait(started.runId);
  }
  async wait(runId: string): Promise<RuntimeSnapshot> {
    while (true) {
      const snapshot = await this.snapshot(runId);
      if (TERMINAL_RUNS.has(snapshot.run.status) || snapshot.run.status === "paused")
        return snapshot;
      await new Promise<void>((resolve) =>
        this.waiters.set(runId, [...(this.waiters.get(runId) ?? []), resolve]),
      );
    }
  }
  async snapshot(runId: string): Promise<RuntimeSnapshot> {
    const run = await this.options.store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const attempts = await this.options.store.listAttempts(runId);
    const events = await this.options.store.listEvents(runId);
    const approvals: ApprovalRecord[] = [];
    for (const attempt of attempts) {
      const approval = await this.options.store.getApproval(runId, attempt.nodeId);
      if (approval) approvals.push(approval);
    }
    return { run, attempts, events, approvals };
  }
  async pause(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (TERMINAL_RUNS.has(run.status) || run.status === "paused") return run;
    const next = this.active.get(runId)?.size ? "pause_requested" : "paused";
    await this.options.store.commit([
      { type: "set_run", runId, patch: { status: next } },
      await this.event(runId, next === "paused" ? "run.paused" : "run.pause_requested"),
    ]);
    if (next === "paused") this.notify(runId);
    return (await this.options.store.getRun(runId)) as RunRecord;
  }
  async resume(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (run.status !== "paused") return run;
    await this.options.store.commit([
      { type: "set_run", runId, patch: { status: "running" } },
      await this.event(runId, "run.resumed"),
    ]);
    setTimeout(() => void this.pump(runId), 0);
    return (await this.options.store.getRun(runId)) as RunRecord;
  }
  async cancel(runId: string, reason = "cancelled by user"): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (TERMINAL_RUNS.has(run.status)) return run;
    await this.options.store.commit([
      { type: "set_run", runId, patch: { status: "cancelling", error: reason } },
      await this.event(runId, "run.cancelling", undefined, undefined, { reason }),
    ]);
    for (const attemptId of this.active.get(runId) ?? [])
      await this.options.provider.cancel?.(attemptId);
    if (!(this.active.get(runId)?.size ?? 0)) await this.finishRun(runId, "cancelled", reason);
    return (await this.options.store.getRun(runId)) as RunRecord;
  }
  async approve(
    runId: string,
    nodeId: string,
    decision: "approved" | "rejected",
  ): Promise<RunRecord> {
    await this.options.store.commit([
      { type: "resolve_approval", runId, nodeId, decision },
      await this.event(runId, "approval.resolved", nodeId, undefined, { decision }),
    ]);
    const attempt = (await this.options.store.listAttempts(runId)).find(
      (item) => item.nodeId === nodeId && item.status === "blocked_approval",
    );
    if (attempt) {
      const completion: Completion =
        decision === "approved"
          ? { status: "succeeded", summary: "Approval granted", outputs: { approved: true } }
          : { status: "failed", summary: "Approval rejected", outputs: {} };
      await this.options.store.commit([
        {
          type: "set_attempt",
          attemptId: attempt.attemptId,
          patch: {
            status: completion.status === "succeeded" ? "succeeded" : "failed",
            completion,
            output: completion.outputs,
            endedAt: this.now(),
            error: decision === "rejected" ? "Approval rejected" : undefined,
          },
        },
        await this.event(runId, "node.completed", nodeId, attempt.attemptId, { completion }),
      ]);
    }
    setTimeout(() => void this.pump(runId), 0);
    return (await this.options.store.getRun(runId)) as RunRecord;
  }
  async retry(runId: string, nodeId: string, inputs?: JsonObject): Promise<AttemptRecord> {
    const key = `${runId}:${nodeId}`;
    const inFlight = this.retrying.get(key);
    if (inFlight) return inFlight;
    const promise = this.retryInternal(runId, nodeId, inputs);
    this.retrying.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.retrying.get(key) === promise) this.retrying.delete(key);
    }
  }
  private async retryInternal(
    runId: string,
    nodeId: string,
    inputs?: JsonObject,
  ): Promise<AttemptRecord> {
    const run = await this.requireRun(runId);
    const previous = (await this.options.store.listAttempts(runId))
      .filter((item) => item.nodeId === nodeId)
      .sort((a, b) => b.attempt - a.attempt)[0];
    if (!previous || !["failed", "cancelled", "skipped"].includes(previous.status))
      throw new Error("Only a failed, cancelled, or skipped node can be retried");
    // A completion callback and a scheduled pump can observe the same failed
    // attempt concurrently. Reuse the already-created next attempt rather
    // than issuing a second side-effecting create command.
    const nextAttempt = (await this.options.store.listAttempts(runId)).find(
      (item) => item.nodeId === nodeId && item.attempt === previous.attempt + 1,
    );
    if (nextAttempt) return nextAttempt;
    const attempt = this.makeAttempt(
      run,
      this.node(run.plan, nodeId),
      previous.attempt + 1,
      inputs ?? previous.input,
      "pending",
    );
    await this.options.store.commit([
      { type: "create_attempt", attempt },
      await this.event(runId, "attempt.created", nodeId, attempt.attemptId, {
        attempt: attempt.attempt,
      }),
    ]);
    if (run.status !== "running")
      await this.options.store.commit([{ type: "set_run", runId, patch: { status: "running" } }]);
    setTimeout(() => void this.pump(runId), 0);
    return attempt;
  }
  /** Recovery is deliberately conservative: no provider is invoked and no side effect is replayed. */
  async recover(): Promise<RunRecord[]> {
    const recovered: RunRecord[] = [];
    for (const run of await this.options.store.listRuns()) {
      if (TERMINAL_RUNS.has(run.status)) continue;
      const attempts = await this.options.store.listAttempts(run.runId);
      const orphaned = attempts.filter((attempt) => attempt.status === "running");
      if (!orphaned.length) continue;
      const commands: RuntimeStoreCommand[] = [];
      for (const attempt of orphaned) {
        commands.push({
          type: "set_attempt",
          attemptId: attempt.attemptId,
          patch: {
            status: "failed",
            error: "interrupted during recovery",
            endedAt: this.now(),
            completion: { status: "failed", summary: "Interrupted during recovery", outputs: {} },
          },
        });
        commands.push(
          await this.event(run.runId, "attempt.failed", attempt.nodeId, attempt.attemptId, {
            error: "interrupted during recovery",
          }),
        );
      }
      commands.push({
        type: "set_run",
        runId: run.runId,
        patch: { status: "paused", error: "interrupted during recovery" },
      });
      commands.push(
        await this.event(run.runId, "runtime.recovery", undefined, undefined, {
          interruptedAttempts: orphaned.map((a) => a.attemptId),
        }),
      );
      await this.options.store.commit(commands);
      recovered.push((await this.options.store.getRun(run.runId)) as RunRecord);
      this.notify(run.runId);
    }
    return recovered;
  }
  private async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.options.store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    return run;
  }
  private node(plan: RuntimePlan, nodeId: string): RuntimeNode {
    const node = plan.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    return node;
  }
  private makeAttempt(
    run: RunRecord,
    node: RuntimeNode,
    number: number,
    input: JsonObject,
    status: AttemptStatus,
  ): AttemptRecord {
    return {
      attemptId: this.makeId(`attempt-${node.id}`),
      runId: run.runId,
      nodeId: node.id,
      attempt: number,
      status,
      input,
      createdAt: this.now(),
    };
  }
  private notify(runId: string): void {
    const waiters = this.waiters.get(runId) ?? [];
    this.waiters.delete(runId);
    for (const resolve of waiters) resolve();
  }
  private async finishRun(
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    error?: string,
  ): Promise<void> {
    await this.options.store.commit([
      { type: "set_run", runId, patch: { status, endedAt: this.now(), error } },
      await this.event(runId, "run.completed", undefined, undefined, {
        status,
        summary: error ?? status,
      }),
    ]);
    this.notify(runId);
  }
  private async pump(runId: string): Promise<void> {
    if (this.pumping.has(runId)) return;
    this.pumping.add(runId);
    try {
      const run = await this.requireRun(runId);
      if (TERMINAL_RUNS.has(run.status) || run.status === "paused") return;
      const attempts = await this.options.store.listAttempts(runId);
      const maxParallel = Math.max(1, Number(run.plan.policies?.concurrency?.maxParallel ?? 1));
      const active = this.active.get(runId) ?? new Set<string>();
      this.active.set(runId, active);
      if (run.status === "pause_requested") {
        if (!active.size) {
          await this.options.store.commit([
            { type: "set_run", runId, patch: { status: "paused" } },
            await this.event(runId, "run.paused"),
          ]);
          this.notify(runId);
        }
        return;
      }
      const commands: RuntimeStoreCommand[] = [];
      const launches: Array<{ node: RuntimeNode; attempt: AttemptRecord }> = [];
      const activeNodeIds = new Set([
        ...(this.activeNodes.get(runId)?.values() ?? []),
        [...active]
          .map((attemptId) => attempts.find((attempt) => attempt.attemptId === attemptId)?.nodeId)
          .filter((nodeId): nodeId is string => nodeId !== undefined),
      ]);
      const skips = this.skippableNodes(run, attempts);
      for (const node of skips) {
        const skipped = this.makeAttempt(run, node, 1, {}, "skipped");
        skipped.completion = {
          status: "skipped",
          summary: "No selected predecessor route",
          outputs: {},
        };
        commands.push(
          { type: "create_attempt", attempt: skipped },
          await this.event(runId, "node.completed", node.id, skipped.attemptId, {
            completion: skipped.completion,
          }),
        );
      }
      const eligible = this.readyNodes(run, attempts);
      for (const node of eligible) {
        if (active.size >= maxParallel) break;
        if (activeNodeIds.has(node.id)) continue;
        if (
          attempts.some(
            (item) =>
              item.nodeId === node.id &&
              (item.status === "ready" ||
                item.status === "running" ||
                item.status === "blocked_approval"),
          )
        )
          continue;
        const input = this.inputFor(run, attempts, node);
        const pending = attempts.find(
          (item) => item.nodeId === node.id && item.status === "pending",
        );
        const attempt = pending ?? this.makeAttempt(run, node, 1, input, "ready");
        // Reserve the node before awaiting event construction. Another pump
        // may wake in that gap (approval resolution and retry both do this).
        active.add(attempt.attemptId);
        const nodeMap = this.activeNodes.get(runId) ?? new Map<string, string>();
        nodeMap.set(attempt.attemptId, node.id);
        this.activeNodes.set(runId, nodeMap);
        if (pending)
          commands.push({
            type: "set_attempt",
            attemptId: pending.attemptId,
            patch: { status: "ready" },
          });
        else commands.push({ type: "create_attempt", attempt });
        commands.push(await this.event(runId, "node.ready", node.id, attempt.attemptId));
        launches.push({ node, attempt });
      }
      if (commands.length) await this.options.store.commit(commands);
      for (const launch of launches) void this.execute(run, launch.node, launch.attempt);
      const latest = await this.options.store.listAttempts(runId);
      if (!active.size && this.allDone(run, latest)) {
        const latestByNode = new Map<string, AttemptRecord>();
        for (const attempt of latest)
          if (
            !latestByNode.has(attempt.nodeId) ||
            (latestByNode.get(attempt.nodeId)?.attempt ?? 0) < attempt.attempt
          )
            latestByNode.set(attempt.nodeId, attempt);
        await this.finishRun(
          runId,
          [...latestByNode.values()].some((attempt) => attempt.status === "failed")
            ? "failed"
            : "succeeded",
        );
      } else if (!active.size && run.status === "cancelling")
        await this.finishRun(runId, "cancelled", run.error);
    } finally {
      this.pumping.delete(runId);
    }
  }
  private inputFor(run: RunRecord, attempts: AttemptRecord[], node: RuntimeNode): JsonObject {
    const bindings = config(node, "inputBindings");
    if (typeof bindings !== "object" || bindings === null) return { ...run.inputs };
    const input: JsonObject = {};
    for (const [key, value] of Object.entries(bindings as Record<string, Record<string, unknown>>))
      input[key] = (refValue(value, run, attempts) as JsonValue) ?? null;
    return input;
  }
  private readyNodes(run: RunRecord, attempts: AttemptRecord[]): RuntimeNode[] {
    const done = new Set(attempts.filter((a) => a.status === "succeeded").map((a) => a.nodeId));
    const terminal = new Set(
      attempts.filter((a) => TERMINAL_ATTEMPTS.has(a.status)).map((a) => a.nodeId),
    );
    const incoming = new Map<string, RuntimeEdge[]>();
    for (const edge of run.plan.edges)
      incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    return run.plan.nodes.filter((node) => {
      const nodeAttempts = attempts.filter((a) => a.nodeId === node.id);
      if (nodeAttempts.some((a) => a.status === "succeeded" || a.status === "skipped"))
        return false;
      if (
        nodeAttempts.some((a) => a.status === "failed" || a.status === "cancelled") &&
        !nodeAttempts.some(
          (a) =>
            a.status === "pending" ||
            a.status === "ready" ||
            a.status === "running" ||
            a.status === "blocked_approval",
        )
      )
        return false;
      if (
        nodeAttempts.some(
          (a) => a.status === "ready" || a.status === "running" || a.status === "blocked_approval",
        )
      )
        return false;
      const edges = incoming.get(node.id) ?? [];
      if (!edges.length)
        return (run.plan.topology?.startNodeIds ?? [run.plan.nodes[0]?.id]).includes(node.id);
      const eligible = edges.filter(
        (edge) => done.has(edge.source) && this.edgeSelected(edge, run, attempts),
      );
      const kind = node.kind;
      if (kind === "join") {
        const policy = String(config(node, "policy") ?? "all");
        const sourceTerminal = edges.every((edge) => terminal.has(edge.source));
        if (policy === "all" && !sourceTerminal) return false;
        const required =
          policy === "all"
            ? eligible.length
            : policy === "quorum"
              ? Number(config(node, "quorum") ?? edges.length)
              : 1;
        return eligible.length >= required;
      }
      if (eligible.length) return true;
      return (
        edges.every((edge) => terminal.has(edge.source)) &&
        edges.every((edge) => !done.has(edge.source))
      );
    });
  }
  private skippableNodes(run: RunRecord, attempts: AttemptRecord[]): RuntimeNode[] {
    const terminal = new Set(
      attempts.filter((a) => TERMINAL_ATTEMPTS.has(a.status)).map((a) => a.nodeId),
    );
    const done = new Set(attempts.filter((a) => a.status === "succeeded").map((a) => a.nodeId));
    return run.plan.nodes.filter((node) => {
      if (attempts.some((a) => a.nodeId === node.id)) return false;
      const incoming = run.plan.edges.filter((edge) => edge.target === node.id);
      if (!incoming.length || !incoming.every((edge) => terminal.has(edge.source))) return false;
      return !incoming.some(
        (edge) => done.has(edge.source) && this.edgeSelected(edge, run, attempts),
      );
    });
  }
  private edgeSelected(edge: RuntimeEdge, run: RunRecord, attempts: AttemptRecord[]): boolean {
    const predecessor = attempts
      .filter((a) => a.nodeId === edge.source && a.status === "succeeded")
      .sort((a, b) => b.attempt - a.attempt)[0];
    if (!predecessor) return false;
    if (edge.condition) return evaluatePredicate(edge.condition as Predicate, run, attempts);
    if (!edge.label) return true;
    return (
      predecessor.completion?.route === edge.label ||
      String(predecessor.output?.route ?? "") === edge.label
    );
  }
  private allDone(run: RunRecord, attempts: AttemptRecord[]): boolean {
    const terminalIds = new Set(
      run.plan.topology?.terminalNodeIds ??
        run.plan.nodes
          .filter((n) => !run.plan.edges.some((e) => e.source === n.id))
          .map((n) => n.id),
    );
    const latest = (nodeId: string) =>
      attempts.filter((a) => a.nodeId === nodeId).sort((a, b) => b.attempt - a.attempt)[0];
    const terminalNodesDone = [...terminalIds].every((id) => {
      const attempt = latest(id);
      if (!attempt || !TERMINAL_ATTEMPTS.has(attempt.status)) return false;
      if (attempt.status === "failed") {
        const node = run.plan.nodes.find((item) => item.id === id);
        if (node && this.retryAllowed(node, attempt, attempt.error)) return false;
      }
      return true;
    });
    const retryableFailure = [...new Set(attempts.map((attempt) => attempt.nodeId))].some(
      (nodeId) => {
        const attempt = latest(nodeId);
        if (!attempt || attempt.status !== "failed") return false;
        const node = run.plan.nodes.find((item) => item.id === nodeId);
        return node ? this.retryAllowed(node, attempt, attempt.error) : false;
      },
    );
    return (
      (!retryableFailure && terminalNodesDone) ||
      (!retryableFailure &&
        attempts.length > 0 &&
        this.readyNodes(run, attempts).length === 0 &&
        attempts.every((a) => TERMINAL_ATTEMPTS.has(a.status)))
    );
  }
  private async execute(run: RunRecord, node: RuntimeNode, attempt: AttemptRecord): Promise<void> {
    const active = this.active.get(run.runId) ?? new Set<string>();
    const activeNodeMap = this.activeNodes.get(run.runId) ?? new Map<string, string>();
    const controller = new AbortController();
    this.controllers.set(attempt.attemptId, controller);
    await this.options.store.commit([
      {
        type: "set_attempt",
        attemptId: attempt.attemptId,
        patch: { status: "running", startedAt: this.now() },
      },
      await this.event(run.runId, "node.started", node.id, attempt.attemptId),
    ]);
    let result: ProviderResult;
    try {
      if (node.kind === "agent")
        result = await this.options.provider.execute({
          runId: run.runId,
          attemptId: attempt.attemptId,
          nodeId: node.id,
          node,
          input: attempt.input,
          signal: controller.signal,
        });
      else if (node.kind === "verify") {
        const verified = await (
          this.options.verifier ?? {
            verify: async (): Promise<VerificationResult> => ({
              status: "passed",
              summary: "Verification passed",
            }),
          }
        ).verify({
          runId: run.runId,
          attemptId: attempt.attemptId,
          nodeId: node.id,
          node,
          input: attempt.input,
        });
        result =
          verified.status === "passed"
            ? { status: "succeeded", summary: verified.summary, outputs: verified.details }
            : { status: "failed", error: verified.summary ?? "Verification failed" };
      } else if (node.kind === "approval") {
        const approval: ApprovalRecord = {
          runId: run.runId,
          nodeId: node.id,
          attemptId: attempt.attemptId,
          key: String(config(node, "approvalKey") ?? node.id),
          message: String(config(node, "message") ?? config(node, "prompt") ?? "Approval required"),
        };
        await this.options.store.commit([
          {
            type: "set_attempt",
            attemptId: attempt.attemptId,
            patch: { status: "blocked_approval" },
          },
          { type: "set_approval", approval },
          await this.event(run.runId, "node.blocked", node.id, attempt.attemptId, {
            reason: "approval",
          }),
          await this.event(run.runId, "approval.requested", node.id, attempt.attemptId, {
            approvalKey: approval.key,
            message: approval.message,
          }),
        ]);
        active.delete(attempt.attemptId);
        activeNodeMap.delete(attempt.attemptId);
        this.controllers.delete(attempt.attemptId);
        setTimeout(() => void this.pump(run.runId), 0);
        return;
      } else if (node.kind === "transform") {
        const mappings = config(node, "mapping");
        const outputs: JsonObject = {};
        if (typeof mappings === "object" && mappings !== null)
          for (const [key, ref] of Object.entries(
            mappings as Record<string, Record<string, unknown>>,
          ))
            outputs[key] =
              (refValue(ref, run, await this.options.store.listAttempts(run.runId)) as JsonValue) ??
              null;
        result = { status: "succeeded", outputs, summary: "Transform completed" };
      } else if (node.kind === "route") {
        const predicate = config(node, "predicate") as Predicate | undefined;
        const routed = predicate
          ? evaluatePredicate(predicate, run, await this.options.store.listAttempts(run.runId))
          : true;
        const route = routed ? "true" : "false";
        result = {
          status: "succeeded",
          route,
          outputs: { route },
          summary: `Selected route ${route}`,
        };
      } else if (node.kind === "join") {
        const prior = (await this.options.store.listAttempts(run.runId)).filter(
          (a) =>
            a.status === "succeeded" &&
            run.plan.edges.some((e) => e.target === node.id && e.source === a.nodeId),
        );
        result = {
          status: "succeeded",
          outputs: { branches: prior.map((a) => a.output ?? {}) },
          summary: "Join completed",
        };
      } else result = { status: "failed", error: `Unsupported node kind ${node.kind}` };
    } catch (error) {
      result = {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.controllers.delete(attempt.attemptId);
    active.delete(attempt.attemptId);
    activeNodeMap.delete(attempt.attemptId);
    const completion: Completion = {
      status: result.status,
      summary: result.summary ?? result.error ?? result.status,
      outputs: result.outputs ?? {},
      ...(result.route ? { route: result.route } : {}),
    };
    const shouldRetry =
      result.status === "failed" && this.retryAllowed(node, attempt, result.error);
    const commands: RuntimeStoreCommand[] = [
      {
        type: "set_attempt",
        attemptId: attempt.attemptId,
        patch: {
          status: result.status,
          output: completion.outputs,
          completion,
          error: result.error,
          endedAt: this.now(),
        },
      },
      await this.event(run.runId, "node.completed", node.id, attempt.attemptId, { completion }),
    ];
    if (shouldRetry)
      commands.push(
        await this.event(run.runId, "attempt.retrying", node.id, attempt.attemptId, {
          nextAttempt: attempt.attempt + 1,
          reason: result.error ?? "failed",
        }),
      );
    await this.options.store.commit(commands);
    if (shouldRetry) {
      await this.retry(run.runId, node.id, attempt.input);
    } else if (result.status === "failed" && !this.hasAlternativeJoin(run, node.id))
      await this.finishRun(run.runId, "failed", result.error);
    else if (
      result.status === "cancelled" &&
      (await this.requireRun(run.runId)).status === "cancelling"
    )
      await this.finishRun(run.runId, "cancelled", result.error);
    else setTimeout(() => void this.pump(run.runId), 0);
  }
  private retryAllowed(node: RuntimeNode, attempt: AttemptRecord, reason?: string): boolean {
    const policy = (config(node, "retry") ?? {}) as RetryPolicy;
    const max = Number(policy.maxAttempts ?? 1);
    if (attempt.attempt >= max) return false;
    const retryOn = policy.retryOn ?? [];
    return (
      retryOn.length === 0 ||
      retryOn.some(
        (kind) =>
          reason?.toLowerCase().includes(kind.replaceAll("_", " ")) ||
          reason?.toLowerCase().includes(kind),
      )
    );
  }
  private hasAlternativeJoin(run: RunRecord, nodeId: string): boolean {
    return run.plan.nodes.some(
      (n) =>
        n.kind === "join" && run.plan.edges.some((e) => e.source === nodeId && e.target === n.id),
    );
  }
}

export { evaluatePredicate, normalizePlan };
