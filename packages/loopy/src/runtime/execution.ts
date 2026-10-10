import {
  type AttemptRecord,
  type AttemptStatus,
  type CommandNode,
  type CommandOutput,
  type ConditionNode,
  type ExecuteCommand,
  errorMessage,
  isBoolean,
  isRecord,
  type Json,
  latestAttempts,
  type ResolvedCommand,
  type RunRecord,
  type WorkflowNode,
} from "../core/index.js";
import { CommandExecutionError } from "./errors.js";
import { assertJson } from "./json.js";
import { type Lease, OWNERSHIP_LOST } from "./lease.js";
import type { RunRepository } from "./repository.js";
import { type Outputs, resolveCommand, resolveValue } from "./resolve.js";

export type Result = {
  status: "succeeded" | "failed" | "interrupted" | "pending";
  error?: string;
};

export type ExecutionOptions = { resume: boolean; retryUncertain: boolean };

export const CANCELLED_BEFORE_LAUNCH = "Run interrupted before command launch.";

const EFFECTS_UNCERTAIN = "Command was interrupted; its external effects are uncertain.";

/** One claimed pass over a run's graph. Attempts and outputs update as nodes settle. */
export class Execution {
  private readonly attempts: Map<string, AttemptRecord>;
  private readonly outputs: Outputs = new Map();

  constructor(
    private readonly store: RunRepository,
    private readonly executor: ExecuteCommand,
    private readonly run: RunRecord,
    private readonly token: string,
    private readonly lease: Lease,
    private readonly signal: AbortSignal,
    private readonly options: ExecutionOptions,
    attempts: AttemptRecord[],
  ) {
    this.attempts = latestAttempts(attempts);

    for (const attempt of this.attempts.values()) {
      if (attempt.status === "succeeded" && attempt.output !== undefined) {
        this.outputs.set(attempt.nodeId, attempt.output);
      }
    }
  }

  async nodes(nodes: readonly WorkflowNode[]): Promise<Result> {
    for (const node of nodes) {
      if (this.signal.aborted) {
        return this.lease.lost ? this.lost() : this.interrupted(CANCELLED_BEFORE_LAUNCH);
      }

      const result = await this.node(node);

      if (result.status !== "succeeded") {
        return result;
      }
    }

    return { status: "succeeded" };
  }

  private async node(node: WorkflowNode): Promise<Result> {
    const previous = this.attempts.get(node.id);
    const blocked = this.blockedBy(node.id, previous);

    if (blocked) {
      return blocked;
    }

    if (node.kind === "condition") {
      return this.condition(node, previous);
    }

    if (previous?.status === "succeeded") {
      return { status: "succeeded" };
    }

    return this.command(node);
  }

  /** A prior failed or uncertain attempt stops the pass unless the caller opted in. */
  private blockedBy(nodeId: string, previous: AttemptRecord | undefined): Result | undefined {
    if (previous?.status === "failed" && !this.options.resume) {
      return { status: "failed", error: previous.error ?? `Node ${nodeId} failed.` };
    }

    if (previous?.status === "uncertain" && !this.options.retryUncertain) {
      return {
        status: "interrupted",
        error: `Node ${nodeId} may have changed external state. Resume with retryUncertain to run it again.`,
      };
    }

    return undefined;
  }

  private async condition(
    node: ConditionNode,
    previous: AttemptRecord | undefined,
  ): Promise<Result> {
    if (previous?.status === "succeeded") {
      const recorded = isRecord(previous.output) ? previous.output.branch : undefined;

      if (recorded !== "then" && recorded !== "else") {
        return { status: "failed", error: `Condition ${node.id} has no recorded branch.` };
      }

      return this.nodes(recorded === "then" ? node.then : node.else);
    }

    let test: Json;

    try {
      test = resolveValue(node.test, this.run.input, this.outputs);

      if (!isBoolean(test)) {
        throw new Error(`Condition ${node.id} must resolve to a boolean.`);
      }
    } catch (error) {
      // SAFETY: The persisted workflow validator accepts only JSON-compatible test operands.
      return this.fail(node.id, { test: node.test as Json }, errorMessage(error));
    }

    const branch = test ? "then" : "else";
    const attempt = await this.store.startAttempt(this.run.id, this.token, node.id, { test });
    await this.finish(attempt, "succeeded", { branch });
    this.outputs.set(node.id, { branch });

    return this.nodes(branch === "then" ? node.then : node.else);
  }

  private async command(node: CommandNode): Promise<Result> {
    let command: ResolvedCommand;

    try {
      command = resolveCommand(node, this.run.input, this.outputs);
    } catch (error) {
      // SAFETY: The compiled workflow snapshot contains only validated command fields and JSON-compatible operands.
      return this.fail(node.id, { command: node.command as Json }, errorMessage(error));
    }

    const attemptInput: unknown = JSON.parse(JSON.stringify(command));
    assertJson(attemptInput, "Resolved command");
    const attempt = await this.store.startAttempt(this.run.id, this.token, node.id, attemptInput);

    this.attempts.set(node.id, attempt);

    // A cancellation that lands before launch leaves nothing to be uncertain about.
    if (this.cancelled()) {
      return this.cancel(attempt);
    }

    if (!(await this.lease.pulse())) {
      return this.lost();
    }

    if (this.cancelled()) {
      return this.cancel(attempt);
    }

    return this.launch(node, command, attempt);
  }

  private async launch(
    node: CommandNode,
    command: ResolvedCommand,
    attempt: AttemptRecord,
  ): Promise<Result> {
    let output: CommandOutput;

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
      return this.launchFailed(attempt, error);
    }

    return this.settle(node, attempt, output);
  }

  private async launchFailed(attempt: AttemptRecord, cause: unknown): Promise<Result> {
    const message = errorMessage(cause);
    const known = cause instanceof CommandExecutionError ? cause : undefined;

    if (known && !known.started && this.cancelled()) {
      await this.finish(attempt, "cancelled", known.output, message);

      return this.interrupted(message);
    }

    // An executor that cannot prove the command never started leaves its effects uncertain.
    if (known && !known.started) {
      await this.finish(attempt, "failed", known.output, message);

      return { status: "failed", error: message };
    }

    await this.finish(attempt, "uncertain", known?.output, message);

    return { status: "interrupted", error: message };
  }

  private async settle(
    node: CommandNode,
    attempt: AttemptRecord,
    output: CommandOutput,
  ): Promise<Result> {
    if (this.signal.aborted) {
      await this.finish(attempt, "uncertain", output, EFFECTS_UNCERTAIN);

      return { status: "interrupted", error: EFFECTS_UNCERTAIN };
    }

    if (output.exitCode !== 0) {
      const error = `Command exited with code ${output.exitCode}.`;
      await this.finish(attempt, "failed", output, error);

      return { status: "failed", error };
    }

    await this.finish(attempt, "succeeded", output);
    this.outputs.set(node.id, output);

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
