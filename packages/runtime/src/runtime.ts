import { createHash } from "node:crypto";
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
export type ProviderPolicy = {
  tools?: {
    allow?: string[];
    deny?: string[];
    network?: "disabled" | "restricted" | "unrestricted";
  };
  workspace?: { workingDirectory?: string; writableRoots?: string[] };
  approval?: { requiredBefore?: string[]; sideEffectLabels?: string[] };
  sandbox?: string;
  budget?: {
    maxTurns?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxOutputTokens?: number;
    maxOutputChars?: number;
  };
  limits?: { maxOutputBytes?: number; maxOutputTokens?: number; maxOutputChars?: number };
  output?: { maxBytes?: number; maxTokens?: number; maxChars?: number };
  [key: string]: unknown;
};
export type RuntimeEdge = WorkflowEdge & { [key: string]: unknown };
export type RuntimePlan = {
  workflowId: string;
  workflowVersion: number;
  nodes: RuntimeNode[];
  edges: RuntimeEdge[];
  topology?: { startNodeIds?: string[]; terminalNodeIds?: string[]; topologicalOrder?: string[] };
  policies?: ProviderPolicy & { concurrency?: { maxParallel?: number } };
  defaults?: { provider?: string; retry?: RetryPolicy };
  execution?: { mode: "local" | "live"; provider?: string };
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
  /** Stable hash of the normalized execution plan used by run events. */
  executionPlanHash?: string;
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
  | {
      type: "set_run";
      runId: string;
      patch: Partial<RunRecord>;
      expectedStatus?: RunStatus;
      /** Explicit seam for retrying a terminal run; ordinary transitions remain strict. */
      allowTerminalRecovery?: boolean;
    }
  | { type: "create_attempt"; attempt: AttemptRecord; expectedRunStatus?: RunStatus }
  | {
      type: "set_attempt";
      attemptId: string;
      patch: Partial<AttemptRecord>;
      expectedStatus?: AttemptStatus;
      expectedRunStatus?: RunStatus;
    }
  | { type: "set_approval"; approval: ApprovalRecord }
  | {
      type: "resolve_approval";
      runId: string;
      nodeId: string;
      attemptId?: string;
      decision: "approved" | "rejected";
      /** Compare-and-set guards; adapters must enforce these in the same transaction. */
      expectedRunStatus?: RunStatus;
      expectedAttemptStatus?: AttemptStatus;
      expectedDecision?: "pending";
    }
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
  /** Fully merged workflow/node policy forwarded to the provider adapter. */
  policy?: ProviderPolicy;
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
  /** Confirms that an external owner has observed and signalled cancellation. */
  observeCancellation?: (runId: string, attemptIds: readonly string[]) => Promise<boolean>;
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
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
function executionPlanHash(plan: RuntimePlan): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(plan)))
    .digest("hex");
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mergePolicy(target: ProviderPolicy, source: unknown): void {
  if (!isRecord(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (key === "concurrency") continue;
    if (isRecord(value) && isRecord(target[key])) {
      (target as Record<string, unknown>)[key] = {
        ...(target[key] as Record<string, unknown>),
        ...value,
      };
    } else if (
      key === "tools" ||
      key === "workspace" ||
      key === "approval" ||
      key === "budget" ||
      key === "limits" ||
      key === "output"
    ) {
      (target as Record<string, unknown>)[key] = isRecord(value) ? { ...value } : value;
    } else if (key === "sandbox" && typeof value === "string") {
      target.sandbox = value;
    }
  }
}
function providerPolicy(run: RunRecord, node: RuntimeNode): ProviderPolicy | undefined {
  const merged: ProviderPolicy = {};
  mergePolicy(merged, run.plan.policies);
  const nodeRecord = node as Record<string, unknown>;
  mergePolicy(merged, nodeRecord.policy);
  mergePolicy(merged, nodeRecord.policies);
  const nested = nodeRecord.configuration;
  if (isRecord(nested)) {
    mergePolicy(merged, nested.policy);
    mergePolicy(merged, nested.policies);
    mergePolicy(merged, nested);
  }
  const tools = isRecord(merged.tools) ? { ...merged.tools } : {};
  const workspace = isRecord(merged.workspace) ? { ...merged.workspace } : {};
  const budget = isRecord(merged.budget) ? { ...merged.budget } : {};
  const direct = (key: string): unknown => config(node, key);
  const allow = direct("toolAllowlist") ?? direct("allowedTools");
  const deny = direct("toolDenylist") ?? direct("disallowedTools");
  const roots = direct("writableRoots");
  const workingDirectory = direct("workingDirectory");
  const sandbox = direct("sandbox") ?? direct("sandboxMode");
  if (allow !== undefined) tools.allow = allow as string[];
  if (deny !== undefined) tools.deny = deny as string[];
  if (roots !== undefined) workspace.writableRoots = roots as string[];
  if (typeof workingDirectory === "string") workspace.workingDirectory = workingDirectory;
  if (typeof sandbox === "string") merged.sandbox = sandbox;
  for (const key of [
    "maxTurns",
    "maxTokens",
    "maxCostUsd",
    "timeoutMs",
    "maxOutputBytes",
    "maxOutputTokens",
    "maxOutputChars",
  ]) {
    const value = direct(key);
    if (value !== undefined) (budget as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(tools).length) merged.tools = tools;
  if (Object.keys(workspace).length) merged.workspace = workspace;
  if (Object.keys(budget).length) merged.budget = budget;
  return Object.keys(merged).length ? merged : undefined;
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
  private readonly cancelling = new Map<string, Promise<RunRecord>>();
  private readonly cancellationRequested = new Set<string>();

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
      executionPlanHash: executionPlanHash(plan),
      inputs,
      status: "created",
      createdAt: this.now(),
    };
    await this.options.store.commit([
      { type: "create_run", run },
      await this.event(run.runId, "run.created", undefined, undefined, {
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        executionPlanHash: run.executionPlanHash,
      }),
    ]);
    await this.options.store.commit([
      { type: "set_run", runId: run.runId, patch: { status: "running", startedAt: this.now() } },
      await this.event(run.runId, "run.started", undefined, undefined, {
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        executionPlanHash: run.executionPlanHash,
        planHash: run.executionPlanHash ?? "fork",
      }),
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
  /** Start a new run from an explicit persisted completed-node checkpoint. */
  async fork(sourceRunId: string, fromNodeId: string, inputs?: JsonObject): Promise<RunRecord> {
    const source = await this.requireRun(sourceRunId);
    if (!(TERMINAL_RUNS.has(source.status) || source.status === "paused"))
      throw new Error(`Run ${sourceRunId} has no stable checkpoint (${source.status})`);
    const sourceAttempts = await this.options.store.listAttempts(sourceRunId);
    const sourceEvents = await this.options.store.listEvents(sourceRunId);
    const checkpoint = sourceEvents.find(
      (event) =>
        event.type === "node.completed" &&
        event.nodeId === fromNodeId &&
        (event.payload?.completion as Record<string, unknown> | undefined)?.status === "succeeded",
    );
    if (!checkpoint) throw new Error(`No safe completed-node checkpoint exists for ${fromNodeId}`);
    const completed = sourceAttempts
      .filter((attempt) => attempt.status === "succeeded" || attempt.status === "skipped")
      .filter((attempt) =>
        sourceEvents.some(
          (event) =>
            event.type === "node.completed" &&
            event.attemptId === attempt.attemptId &&
            event.sequence <= checkpoint.sequence,
        ),
      )
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.attempt - b.attempt);
    const latest = new Map<string, AttemptRecord>();
    for (const attempt of completed) latest.set(attempt.nodeId, attempt);
    if (!latest.has(fromNodeId))
      throw new Error(`Checkpoint ${fromNodeId} has no persisted completed attempt`);

    // A fork must not replay a completed side effect merely because it was
    // persisted after the selected checkpoint. Carry its causal closure only
    // when the source graph proves that the same branch/join inputs were
    // completed; otherwise fail closed before creating the new run.
    const allCompleted = new Map<string, AttemptRecord>();
    for (const attempt of sourceAttempts) {
      if (attempt.status !== "succeeded" && attempt.status !== "skipped") continue;
      const completionEvent = sourceEvents.find(
        (event) => event.type === "node.completed" && event.attemptId === attempt.attemptId,
      );
      if (completionEvent) allCompleted.set(attempt.nodeId, attempt);
    }
    const carry = new Set(latest.keys());
    const forkInputs = inputs ?? source.inputs;
    const forkGraph = { ...source, inputs: forkInputs };
    const inputsChanged = JSON.stringify(forkInputs) !== JSON.stringify(source.inputs);
    const sideEffectNode = (node: RuntimeNode | undefined): boolean => {
      return node?.sideEffect === true;
    };
    const causalCarry = (nodeId: string, visiting = new Set<string>()): boolean => {
      if (carry.has(nodeId)) return true;
      if (visiting.has(nodeId)) return false;
      const attempt = allCompleted.get(nodeId);
      if (!attempt) return false;
      const incoming = source.plan.edges.filter((edge) => edge.target === nodeId);
      if (
        incoming.some(
          (edge) =>
            !this.edgeSelected(edge, forkGraph, sourceAttempts) ||
            !causalCarry(edge.source, new Set([...visiting, nodeId])),
        )
      )
        return false;
      carry.add(nodeId);
      latest.set(nodeId, attempt);
      return true;
    };
    for (const attempt of allCompleted.values()) {
      const completionEvent = sourceEvents.find(
        (event) => event.type === "node.completed" && event.attemptId === attempt.attemptId,
      );
      if (!completionEvent || completionEvent.sequence <= checkpoint.sequence) continue;
      const node = source.plan.nodes.find((item) => item.id === attempt.nodeId);
      if (sideEffectNode(node) && (inputsChanged || !causalCarry(attempt.nodeId)))
        throw new Error(
          `Fork checkpoint ${fromNodeId} is unsafe for completed side effect ${attempt.nodeId}`,
        );
    }
    const run: RunRecord = {
      runId: this.makeId("fork"),
      workflowId: source.workflowId,
      workflowVersion: source.workflowVersion,
      plan: source.plan,
      executionPlanHash: source.executionPlanHash,
      inputs: forkInputs,
      status: "running",
      createdAt: this.now(),
      startedAt: this.now(),
    };
    const clones = [...latest.values()].map((attempt) => ({
      ...attempt,
      attemptId: this.makeId(`fork-attempt-${attempt.nodeId}`),
      runId: run.runId,
      attempt: 1,
      createdAt: this.now(),
      startedAt: undefined,
      endedAt: this.now(),
    }));
    const commands: RuntimeStoreCommand[] = [
      { type: "create_run", run },
      await this.event(run.runId, "run.created", undefined, undefined, {
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        executionPlanHash: run.executionPlanHash,
        forkedFromRunId: sourceRunId,
        checkpointNodeId: fromNodeId,
      }),
    ];
    for (const attempt of clones) {
      commands.push({ type: "create_attempt", attempt });
      if (source.plan.nodes.find((node) => node.id === attempt.nodeId)?.kind === "approval") {
        const approval = await this.options.store.getApproval(sourceRunId, attempt.nodeId);
        if (approval) {
          commands.push({
            type: "set_approval",
            approval: { ...approval, runId: run.runId, attemptId: attempt.attemptId },
          });
        }
      }
      commands.push(
        await this.event(run.runId, "node.completed", attempt.nodeId, attempt.attemptId, {
          completion: attempt.completion ?? {
            status: attempt.status === "skipped" ? "skipped" : "succeeded",
            summary: "Carried from explicit fork checkpoint",
            outputs: attempt.output ?? {},
          },
          carriedFromRunId: sourceRunId,
        }),
      );
    }
    commands.push(
      await this.event(run.runId, "run.started", undefined, undefined, {
        planHash: run.executionPlanHash,
        forkedFromRunId: sourceRunId,
        checkpointNodeId: fromNodeId,
      }),
    );
    await this.options.store.commit(commands);
    void this.pump(run.runId);
    return (await this.options.store.getRun(run.runId)) as RunRecord;
  }
  async wait(runId: string): Promise<RuntimeSnapshot> {
    while (true) {
      const snapshot = await this.snapshot(runId);
      if (TERMINAL_RUNS.has(snapshot.run.status) || snapshot.run.status === "paused")
        return snapshot;
      // Register before the second read. If completion races this registration,
      // the recheck consumes it instead of leaving a lost wake-up waiter.
      let resolveWaiter!: () => void;
      const waiter = new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        this.waiters.set(runId, [...(this.waiters.get(runId) ?? []), resolve]);
      });
      const rechecked = await this.snapshot(runId);
      if (TERMINAL_RUNS.has(rechecked.run.status) || rechecked.run.status === "paused") {
        const waiters = this.waiters.get(runId) ?? [];
        this.waiters.set(
          runId,
          waiters.filter((item) => item !== resolveWaiter),
        );
        return rechecked;
      }
      await waiter;
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
    const inFlight = this.cancelling.get(runId);
    if (inFlight) return inFlight;
    const promise = this.cancelInternal(runId, reason);
    this.cancelling.set(runId, promise);
    try {
      return await promise;
    } finally {
      if (this.cancelling.get(runId) === promise) this.cancelling.delete(runId);
    }
  }
  private async cancelInternal(runId: string, reason: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (TERMINAL_RUNS.has(run.status)) return run;
    this.cancellationRequested.add(runId);
    await this.options.store.commit([
      { type: "set_run", runId, patch: { status: "cancelling", error: reason } },
      await this.event(runId, "run.cancelling", undefined, undefined, { reason }),
    ]);
    const attemptIds = new Set(this.active.get(runId) ?? []);
    for (const attemptId of attemptIds) {
      this.controllers.get(attemptId)?.abort(reason);
      this.cancelProviderAttempt(attemptId);
    }
    const attempts = await this.options.store.listAttempts(runId);
    const runningAttemptIds = attempts
      .filter((attempt) => attempt.status === "running")
      .map((attempt) => attempt.attemptId);
    const locallyOwned = runningAttemptIds.some((attemptId) =>
      this.active.get(runId)?.has(attemptId),
    );
    if (
      runningAttemptIds.length > 0 &&
      !locallyOwned &&
      !(await this.options.observeCancellation?.(runId, runningAttemptIds))
    ) {
      // A different process may own the provider session. Without a durable
      // owner observation, terminal cancellation would falsely promise that
      // the provider has stopped while it can still produce side effects.
      return (await this.options.store.getRun(runId)) as RunRecord;
    }
    const commands: RuntimeStoreCommand[] = [];
    for (const attempt of attempts) {
      if (TERMINAL_ATTEMPTS.has(attempt.status)) continue;
      const completion: Completion = {
        status: "cancelled",
        summary: reason,
        outputs: {},
      };
      commands.push(
        {
          type: "set_attempt",
          attemptId: attempt.attemptId,
          patch: {
            status: "cancelled",
            completion,
            output: {},
            error: reason,
            endedAt: this.now(),
          },
        },
        await this.event(runId, "attempt.cancelled", attempt.nodeId, attempt.attemptId, { reason }),
      );
    }
    commands.push(
      {
        type: "set_run",
        runId,
        patch: { status: "cancelled", endedAt: this.now(), error: reason },
      },
      await this.event(runId, "run.completed", undefined, undefined, {
        status: "cancelled",
        summary: reason,
      }),
    );
    if (commands.length > 1) await this.options.store.commit(commands);
    this.active.get(runId)?.clear();
    this.activeNodes.get(runId)?.clear();
    this.notify(runId);
    return (await this.options.store.getRun(runId)) as RunRecord;
  }
  async approve(
    runId: string,
    nodeId: string,
    decision: "approved" | "rejected",
  ): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (run.status !== "running") throw new Error("Approvals require an active running run");
    const approval = await this.options.store.getApproval(runId, nodeId);
    const attempt = (await this.options.store.listAttempts(runId)).find(
      (item) => item.nodeId === nodeId && item.status === "blocked_approval",
    );
    if (!approval || approval.decision) throw new Error("No pending approval");
    if (!attempt) throw new Error("No pending approval attempt");
    const completion: Completion =
      decision === "approved"
        ? { status: "succeeded", summary: "Approval granted", outputs: { approved: true } }
        : { status: "failed", summary: "Approval rejected", outputs: {} };
    await this.options.store.commit([
      {
        type: "resolve_approval",
        runId,
        nodeId,
        attemptId: attempt.attemptId,
        decision,
        expectedRunStatus: "running",
        expectedAttemptStatus: "blocked_approval",
        expectedDecision: "pending",
      },
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
      await this.event(runId, "approval.resolved", nodeId, attempt.attemptId, { decision }),
      await this.event(runId, "node.completed", nodeId, attempt.attemptId, { completion }),
    ]);
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
    if (!["running", "failed", "cancelled", "paused"].includes(run.status))
      throw new Error(`Run ${runId} is not retryable from ${run.status}`);
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
    const commands: RuntimeStoreCommand[] = [
      { type: "create_attempt", attempt, expectedRunStatus: run.status },
      await this.event(runId, "attempt.created", nodeId, attempt.attemptId, {
        attempt: attempt.attempt,
      }),
    ];
    if (run.status !== "running") {
      commands.push(
        {
          type: "set_run",
          runId,
          patch: { status: "running", endedAt: undefined, error: undefined },
          expectedStatus: run.status,
          allowTerminalRecovery: run.status === "failed" || run.status === "cancelled",
        },
        await this.event(runId, "run.resumed", undefined, undefined, { resumedBy: "retry" }),
      );
      this.cancellationRequested.delete(runId);
    }
    // The attempt and explicit terminal-run transition are one atomic commit.
    // Adapters must reject the whole batch on a failed compare/transition check.
    await this.options.store.commit(commands);
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
      const commands: RuntimeStoreCommand[] = [];
      if (run.status === "cancelling") {
        for (const attempt of attempts) {
          if (
            !(
              attempt.status === "pending" ||
              attempt.status === "ready" ||
              attempt.status === "running"
            )
          )
            continue;
          const completion: Completion = {
            status: "cancelled",
            summary: run.error ?? "cancelled during recovery",
            outputs: {},
          };
          commands.push(
            {
              type: "set_attempt",
              attemptId: attempt.attemptId,
              patch: {
                status: "cancelled",
                error: completion.summary,
                output: {},
                endedAt: this.now(),
                completion,
              },
              expectedStatus: attempt.status,
            },
            await this.event(run.runId, "attempt.cancelled", attempt.nodeId, attempt.attemptId, {
              reason: completion.summary,
            }),
          );
        }
        commands.push(
          {
            type: "set_run",
            runId: run.runId,
            patch: { status: "cancelled", endedAt: this.now() },
            expectedStatus: "cancelling",
          },
          await this.event(run.runId, "run.completed", undefined, undefined, {
            status: "cancelled",
            summary: run.error ?? "cancelled during recovery",
          }),
        );
      } else {
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
            expectedStatus: "running",
          });
          commands.push(
            await this.event(run.runId, "attempt.failed", attempt.nodeId, attempt.attemptId, {
              error: "interrupted during recovery",
            }),
          );
        }
        if (run.status === "created") {
          // A process can stop after create_run and before the normal start
          // transition. Recover that legal boundary by starting it once.
          commands.push({
            type: "set_run",
            runId: run.runId,
            patch: { status: "running", startedAt: run.startedAt ?? this.now() },
            expectedStatus: "created",
          });
        } else if (run.status !== "paused") {
          commands.push({
            type: "set_run",
            runId: run.runId,
            patch: {
              status: "paused",
              error: orphaned.length ? "interrupted during recovery" : run.error,
            },
            expectedStatus: run.status,
          });
        }
        if (orphaned.length || run.status !== "paused")
          commands.push(
            await this.event(run.runId, "runtime.recovery", undefined, undefined, {
              interruptedAttempts: orphaned.map((a) => a.attemptId),
            }),
          );
      }
      if (!commands.length) continue;
      await this.options.store.commit(commands);
      const recoveredRun = (await this.options.store.getRun(run.runId)) as RunRecord;
      recovered.push(recoveredRun);
      if (recoveredRun.status === "running") setTimeout(() => void this.pump(run.runId), 0);
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
  /** Provider cleanup is advisory and must never delay terminal cancellation. */
  private cancelProviderAttempt(attemptId: string): void {
    const cancel = this.options.provider.cancel;
    if (!cancel) return;
    // Invoke the owner hook synchronously before terminal state is persisted;
    // awaiting provider cleanup is intentionally not required here.
    try {
      void Promise.resolve(cancel.call(this.options.provider, attemptId)).catch(() => undefined);
    } catch {
      // Cancellation remains conservative if the provider hook rejects or throws.
    }
  }
  private async finishRun(
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    error?: string,
  ): Promise<void> {
    const current = await this.requireRun(runId);
    if (TERMINAL_RUNS.has(current.status)) return;
    if (
      (this.cancellationRequested.has(runId) || current.status === "cancelling") &&
      status !== "cancelled"
    )
      return;
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
      if (
        TERMINAL_RUNS.has(run.status) ||
        run.status === "paused" ||
        run.status === "cancelling" ||
        this.cancellationRequested.has(runId)
      )
        return;
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
          { type: "create_attempt", attempt: skipped, expectedRunStatus: "running" },
          await this.event(runId, "node.completed", node.id, skipped.attemptId, {
            completion: skipped.completion,
          }),
        );
      }
      for (const node of this.impossibleJoins(run, attempts)) {
        const failed = this.makeAttempt(run, node, 1, {}, "failed");
        failed.error = "Join cannot satisfy its policy";
        failed.completion = {
          status: "failed",
          summary: failed.error,
          outputs: {},
        };
        commands.push(
          { type: "create_attempt", attempt: failed, expectedRunStatus: "running" },
          await this.event(runId, "node.completed", node.id, failed.attemptId, {
            completion: failed.completion,
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
              (item.status === "running" || item.status === "blocked_approval"),
          )
        )
          continue;
        const input = this.inputFor(run, attempts, node);
        const pending = attempts.find(
          (item) => item.nodeId === node.id && item.status === "pending",
        );
        const ready = attempts.find((item) => item.nodeId === node.id && item.status === "ready");
        const attempt = ready ?? pending ?? this.makeAttempt(run, node, 1, input, "ready");
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
            expectedStatus: "pending",
            expectedRunStatus: "running",
          });
        else if (!ready)
          commands.push({ type: "create_attempt", attempt, expectedRunStatus: "running" });
        if (!ready)
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
      }
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
      if (nodeAttempts.some((a) => a.status === "running" || a.status === "blocked_approval"))
        return false;
      const edges = incoming.get(node.id) ?? [];
      if (!edges.length)
        return (run.plan.topology?.startNodeIds ?? [run.plan.nodes[0]?.id]).includes(node.id);
      const eligible = edges.filter(
        (edge) => done.has(edge.source) && this.edgeSelected(edge, run, attempts),
      );
      const kind = node.kind;
      if (kind === "join") {
        return this.joinReadiness(node, edges, done, terminal, run, attempts).state === "ready";
      }
      if (eligible.length) return true;
      return (
        edges.every((edge) => terminal.has(edge.source)) &&
        edges.every((edge) => !done.has(edge.source))
      );
    });
  }

  private joinReadiness(
    node: RuntimeNode,
    edges: RuntimeEdge[],
    done: Set<string>,
    terminal: Set<string>,
    run: RunRecord,
    attempts: AttemptRecord[],
  ): { state: "ready" | "waiting" | "impossible"; selected: string[] } {
    const sources = [...new Set(edges.map((edge) => edge.source))];
    const selected = sources.filter((source) =>
      edges.some(
        (edge) =>
          edge.source === source && done.has(source) && this.edgeSelected(edge, run, attempts),
      ),
    );
    const policy = String(config(node, "policy") ?? "all");
    const required =
      policy === "all"
        ? selected.length
        : policy === "quorum"
          ? Number(config(node, "quorum") ?? sources.length)
          : 1;
    const successes = selected.length;
    if (policy === "all") {
      if (!sources.every((source) => terminal.has(source))) return { state: "waiting", selected };
      // A failed/cancelled predecessor cannot become an eligible success.
      return { state: successes === sources.length ? "ready" : "impossible", selected };
    }
    if (successes >= required) return { state: "ready", selected };
    if (sources.every((source) => terminal.has(source))) return { state: "impossible", selected };
    return { state: "waiting", selected };
  }

  private impossibleJoins(run: RunRecord, attempts: AttemptRecord[]): RuntimeNode[] {
    const done = new Set(attempts.filter((a) => a.status === "succeeded").map((a) => a.nodeId));
    const terminal = new Set(
      attempts.filter((a) => TERMINAL_ATTEMPTS.has(a.status)).map((a) => a.nodeId),
    );
    return run.plan.nodes.filter((node) => {
      if (node.kind !== "join" || attempts.some((attempt) => attempt.nodeId === node.id))
        return false;
      const edges = run.plan.edges.filter((edge) => edge.target === node.id);
      return this.joinReadiness(node, edges, done, terminal, run, attempts).state === "impossible";
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
      if (node.kind === "join") return false;
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
    try {
      if (this.cancellationRequested.has(run.runId)) return;
      await this.options.store.commit([
        {
          type: "set_attempt",
          attemptId: attempt.attemptId,
          patch: { status: "running", startedAt: this.now() },
          expectedStatus: "ready",
          expectedRunStatus: "running",
        },
        await this.event(run.runId, "node.started", node.id, attempt.attemptId),
      ]);
    } catch (error) {
      // Cancellation may have terminalized this ready attempt before launch.
      if (this.cancellationRequested.has(run.runId)) {
        this.controllers.delete(attempt.attemptId);
        active.delete(attempt.attemptId);
        activeNodeMap.delete(attempt.attemptId);
        return;
      }
      throw error;
    }
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
          policy: providerPolicy(run, node),
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
            expectedStatus: "running",
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
        const currentAttempts = await this.options.store.listAttempts(run.runId);
        const incoming = run.plan.edges.filter((edge) => edge.target === node.id);
        const sourceOrder = [...new Set(incoming.map((edge) => edge.source))];
        const prior = sourceOrder
          .map(
            (source) =>
              currentAttempts
                .filter((a) => a.nodeId === source && a.status === "succeeded")
                .sort((a, b) => b.attempt - a.attempt)[0],
          )
          .filter((a): a is AttemptRecord => a !== undefined)
          .filter((a) =>
            incoming.some(
              (edge) => edge.source === a.nodeId && this.edgeSelected(edge, run, currentAttempts),
            ),
          );
        const mode = String(config(node, "outputMode") ?? "array");
        const branchOutputs = prior.map((a) => a.output ?? {});
        const branches =
          mode === "object"
            ? Object.fromEntries(prior.map((a) => [a.nodeId, a.output ?? {}]))
            : mode === "first_success"
              ? (branchOutputs[0] ?? {})
              : branchOutputs;
        result = {
          status: "succeeded",
          outputs: { branches: branches as JsonValue },
          summary: "Join completed",
        };
      } else result = { status: "failed", error: `Unsupported node kind ${node.kind}` };
    } catch (error) {
      result = {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const currentRun = await this.requireRun(run.runId);
    const currentAttempt = (await this.options.store.listAttempts(run.runId)).find(
      (item) => item.attemptId === attempt.attemptId,
    );
    const cancelled =
      this.cancellationRequested.has(run.runId) ||
      currentRun.status === "cancelling" ||
      currentRun.status === "cancelled" ||
      currentAttempt?.status === "cancelled";
    if (cancelled) result = { status: "cancelled", error: currentRun.error ?? "cancelled" };
    this.controllers.delete(attempt.attemptId);
    active.delete(attempt.attemptId);
    activeNodeMap.delete(attempt.attemptId);
    if (currentAttempt && TERMINAL_ATTEMPTS.has(currentAttempt.status)) {
      if (currentAttempt.status === "cancelled") this.notify(run.runId);
      return;
    }
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
        expectedStatus: "running",
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
    try {
      await this.options.store.commit(commands);
    } catch (error) {
      if (!cancelled) throw error;
      return;
    }
    if (shouldRetry) {
      await this.retry(run.runId, node.id, attempt.input);
    } else if (result.status === "failed" && !this.hasAlternativeJoin(run, node.id))
      await this.finishRun(run.runId, "failed", result.error);
    else if (
      result.status === "cancelled" &&
      (await this.requireRun(run.runId)).status === "cancelling"
    )
      await this.finishRun(run.runId, "cancelled", result.error);
    else if (!cancelled && !this.cancellationRequested.has(run.runId))
      setTimeout(() => void this.pump(run.runId), 0);
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
