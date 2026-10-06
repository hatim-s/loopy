import type {
  AttemptRecord,
  AttemptStatus,
  CommandNode,
  ConditionNode,
  ExecuteCommand,
  Json,
  RunEvent,
  RunOptions,
  RunRecord,
  Workflow,
  WorkflowNode,
} from "../core/model.js";
import { validateWorkflow } from "../core/workflow.js";
import { CommandExecutionError, errorMessage } from "./errors.js";
import { InputValidationError, validateRunInput } from "./preflight.js";
import type { RunRepository } from "./repository.js";
import { assertJson, type Outputs, resolveCommand, resolveValue } from "./values.js";

type Result = { status: "succeeded" | "failed" | "interrupted" | "pending"; error?: string };
type ExecuteOptions = { retryUncertain?: boolean; resume?: boolean; signal?: AbortSignal };

const OWNERSHIP_LOST = "Run ownership lost";
const CANCELLED_BEFORE_LAUNCH = "Run interrupted before command launch";

function latestAttempts(attempts: AttemptRecord[]): Map<string, AttemptRecord> {
  const latest = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const prior = latest.get(attempt.nodeId);
    if (!prior || attempt.number > prior.number) latest.set(attempt.nodeId, attempt);
  }
  return latest;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkRunOptions(options: RunOptions): RunOptions {
  if (options.mode !== "sandbox" && options.mode !== "full")
    throw new Error(`Invalid execution mode ${String(options.mode)}`);
  const workspace = options.workspace;
  if (workspace?.kind === "local" && typeof workspace.path === "string" && workspace.path)
    return { workspace: { kind: "local", path: workspace.path }, mode: options.mode };
  if (workspace?.kind === "managed" && typeof workspace.id === "string" && workspace.id)
    return { workspace: { kind: "managed", id: workspace.id }, mode: options.mode };
  throw new Error("Invalid workspace");
}

/**
 * Keeps the run's owner token fresh with single-flight heartbeats. Losing
 * ownership aborts the shared controller so a launched command stops too.
 */
class Lease {
  private inFlight?: Promise<boolean>;
  private timer?: ReturnType<typeof setInterval>;
  private failed = false;
  error?: unknown;

  constructor(
    private readonly beat: () => Promise<boolean>,
    private readonly controller: AbortController,
    intervalMs: number,
  ) {
    this.timer = setInterval(() => void this.pulse(), intervalMs);
  }

  get lost(): boolean {
    return this.failed;
  }

  pulse(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.resolve()
      .then(this.beat)
      .then((owned) => {
        if (!owned) this.fail(new Error(OWNERSHIP_LOST));
        return owned;
      })
      .catch((error: unknown) => {
        this.fail(error);
        return false;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private fail(error: unknown): void {
    this.failed = true;
    this.error = error;
    this.controller.abort(error);
  }

  /** Stops the timer and drains any heartbeat still in flight. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.inFlight) await this.inFlight;
  }
}

/** One claimed pass over a run's graph. Attempts and outputs update as nodes settle. */
class Execution {
  private readonly attempts: Map<string, AttemptRecord>;
  private readonly outputs: Outputs = new Map();

  constructor(
    private readonly store: RunRepository,
    private readonly executor: ExecuteCommand,
    private readonly run: RunRecord,
    private readonly token: string,
    private readonly lease: Lease,
    private readonly signal: AbortSignal,
    private readonly options: { resume: boolean; retryUncertain: boolean },
    attempts: AttemptRecord[],
  ) {
    this.attempts = latestAttempts(attempts);
    for (const attempt of this.attempts.values())
      if (attempt.status === "succeeded" && attempt.output !== undefined)
        this.outputs.set(attempt.nodeId, attempt.output);
  }

  async nodes(nodes: readonly WorkflowNode[]): Promise<Result> {
    for (const [index, node] of nodes.entries()) {
      if (this.signal.aborted)
        return this.lease.lost ? this.lost() : this.interrupted(CANCELLED_BEFORE_LAUNCH);
      try {
        validateRunInput(nodes.slice(index), this.run.input, this.outputs);
      } catch (error) {
        if (!(error instanceof InputValidationError)) throw error;
        return this.fail(error.nodeId, { preflight: true }, error.message);
      }
      const previous = this.attempts.get(node.id);
      if (previous?.status === "failed" && !this.options.resume)
        return { status: "failed", error: previous.error ?? `Node ${node.id} failed` };
      if (previous?.status === "uncertain" && !this.options.retryUncertain)
        return {
          status: "interrupted",
          error: `Node ${node.id} may have changed external state. Resume with retryUncertain to run it again.`,
        };
      const result =
        node.kind === "condition"
          ? await this.condition(node, previous)
          : previous?.status === "succeeded"
            ? undefined
            : await this.command(node);
      if (result && result.status !== "succeeded") return result;
    }
    return { status: "succeeded" };
  }

  private async condition(
    node: ConditionNode,
    previous: AttemptRecord | undefined,
  ): Promise<Result> {
    let branch: "then" | "else";
    if (previous?.status === "succeeded") {
      const recorded = (previous.output as { branch?: unknown } | undefined)?.branch;
      if (recorded !== "then" && recorded !== "else")
        return { status: "failed", error: `Condition ${node.id} has no recorded branch` };
      branch = recorded;
    } else {
      let test: Json;
      try {
        test = resolveValue(node.test, this.run.input, this.outputs);
        if (typeof test !== "boolean")
          throw new Error(`Condition ${node.id} must resolve to boolean`);
      } catch (error) {
        return this.fail(node.id, { test: node.test as Json }, errorMessage(error));
      }
      branch = test ? "then" : "else";
      const attempt = await this.store.startAttempt(this.run.id, this.token, node.id, { test });
      await this.finish(attempt, "succeeded", { branch });
      this.outputs.set(node.id, { branch });
    }
    return this.nodes(branch === "then" ? node.then : node.else);
  }

  private async command(node: CommandNode): Promise<Result> {
    let command: ReturnType<typeof resolveCommand>;
    try {
      command = resolveCommand(node, this.run.input, this.outputs);
    } catch (error) {
      return this.fail(node.id, { command: node.command as Json }, errorMessage(error));
    }
    const attempt = await this.store.startAttempt(
      this.run.id,
      this.token,
      node.id,
      command as Json,
    );
    this.attempts.set(node.id, attempt);

    // A cancellation that lands before launch leaves nothing to be uncertain about.
    if (this.cancelled()) return this.cancel(attempt);
    if (!(await this.lease.pulse())) return this.lost();
    if (this.cancelled()) return this.cancel(attempt);

    let output: Awaited<ReturnType<ExecuteCommand>>;
    try {
      output = await this.executor(command, {
        ...this.run.options,
        runId: this.run.id,
        nodeId: node.id,
        attemptId: attempt.id,
        ownerToken: this.token,
        signal: this.signal,
      });
    } catch (error) {
      const message = errorMessage(error);
      const known = error instanceof CommandExecutionError ? error : undefined;
      if (known && !known.started && this.cancelled()) {
        await this.finish(attempt, "cancelled", known.output as Json, message);
        return this.interrupted(message);
      }
      // An executor that cannot prove the command never started leaves its effects uncertain.
      const status = known && !known.started ? "failed" : "uncertain";
      await this.finish(attempt, status, known?.output as Json | undefined, message);
      return { status: status === "failed" ? "failed" : "interrupted", error: message };
    }
    if (this.signal.aborted) {
      const error = "Command was interrupted; its external effects are uncertain";
      await this.finish(attempt, "uncertain", output as Json, error);
      return { status: "interrupted", error };
    }
    if (output.exitCode !== 0) {
      const error = `Command exited with code ${output.exitCode}`;
      await this.finish(attempt, "failed", output as Json, error);
      return { status: "failed", error };
    }
    await this.finish(attempt, "succeeded", output as Json);
    this.outputs.set(node.id, output as Json);
    return { status: "succeeded" };
  }

  private cancelled(): boolean {
    return this.signal.aborted && !this.lease.lost;
  }

  private lost(): Result {
    return { status: "interrupted", error: OWNERSHIP_LOST };
  }

  /** Initial deliveries go back to pending so a queue can redeliver; resumes stay interrupted. */
  private interrupted(error: string): Result {
    return { status: this.options.resume ? "interrupted" : "pending", error };
  }

  private async cancel(attempt: AttemptRecord): Promise<Result> {
    await this.finish(attempt, "cancelled", undefined, CANCELLED_BEFORE_LAUNCH);
    return this.interrupted(CANCELLED_BEFORE_LAUNCH);
  }

  /** Records a node that failed before anything launched. */
  private async fail(nodeId: string, input: Json, error: string): Promise<Result> {
    const attempt = await this.store.startAttempt(this.run.id, this.token, nodeId, input);
    await this.finish(attempt, "failed", undefined, error);
    return { status: "failed", error };
  }

  private async finish(
    attempt: AttemptRecord,
    status: Exclude<AttemptStatus, "running">,
    output?: Json,
    error?: string,
  ): Promise<void> {
    const finished = await this.store.finishAttempt(
      this.run.id,
      this.token,
      attempt.id,
      status,
      output,
      error,
    );
    this.attempts.set(attempt.nodeId, finished);
  }
}

export class Runtime {
  private readonly store: RunRepository;
  private readonly executor: ExecuteCommand;
  private readonly heartbeatIntervalMs: number;

  constructor(options: {
    store: RunRepository;
    executor: ExecuteCommand;
    heartbeatIntervalMs?: number;
  }) {
    this.store = options.store;
    this.executor = options.executor;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3_000;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0)
      throw new Error("heartbeatIntervalMs must be a positive integer");
  }

  /** Freezes the graph, input and options so later edits never reach a run. */
  async createRun(workflow: Workflow, input: Json, options: RunOptions): Promise<RunRecord> {
    validateWorkflow(workflow);
    assertJson(input);
    validateRunInput(workflow.nodes, input);
    const savedInput = JSON.parse(JSON.stringify(input)) as Json;
    const savedOptions = checkRunOptions(options);
    const snapshot = JSON.stringify(workflow);
    const createdAt = new Date().toISOString();
    const run: RunRecord = {
      id: crypto.randomUUID(),
      slug: workflow.slug,
      workflow: JSON.parse(snapshot) as Workflow,
      workflowHash: await sha256(snapshot),
      input: savedInput,
      options: savedOptions,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    await this.store.createRun(run);
    return run;
  }

  getRun(id: string): Promise<RunRecord | undefined> {
    return this.store.getRun(id);
  }

  listRuns(slug?: string): Promise<RunRecord[]> {
    return this.store.listRuns(slug);
  }

  getAttempts(id: string): Promise<AttemptRecord[]> {
    return this.store.getAttempts(id);
  }

  getEvents(id: string, after?: number): Promise<RunEvent[]> {
    return this.store.getEvents(id, after);
  }

  /**
   * Claims the run, walks its graph, and releases the claim. Terminal runs come
   * back unchanged. Throws when storage or the lease fails; the run stays claimed
   * as running until its owner is recovered.
   */
  async execute(id: string, options: ExecuteOptions = {}): Promise<RunRecord> {
    const token = crypto.randomUUID();
    const run = await this.store.claim(id, token, { resume: options.resume });
    if (run.status !== "running") return run;

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    const lease = new Lease(
      () => this.store.heartbeat(id, token),
      controller,
      this.heartbeatIntervalMs,
    );

    let outcome: { run: RunRecord } | { error: unknown };
    try {
      const execution = new Execution(
        this.store,
        this.executor,
        run,
        token,
        lease,
        controller.signal,
        { resume: options.resume !== false, retryUncertain: Boolean(options.retryUncertain) },
        await this.store.getAttempts(id),
      );
      const result = await execution.nodes(run.workflow.nodes);
      // Drain heartbeats first: one landing after the final write would read as lost ownership.
      await lease.stop();
      if (lease.lost) throw lease.error;
      outcome = { run: await this.store.finishRun(id, token, result.status, result.error) };
    } catch (error) {
      outcome = { error };
    }
    await lease.stop();
    options.signal?.removeEventListener("abort", forwardAbort);
    try {
      await this.store.release(id, token);
    } catch (error) {
      if ("run" in outcome) outcome = { error };
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.run;
  }
}
