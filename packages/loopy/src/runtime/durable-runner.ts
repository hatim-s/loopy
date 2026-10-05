import type { ArtifactStore, RuntimeIdentity, TenantScope } from "../application/ports.js";
import type { AttemptRecord, Json, RunRecord } from "../core/model.js";
import {
  getExecutionArtifact,
  hydrateAttempts,
  putExecutionArtifact,
} from "./attempt-artifacts.js";
import { errorMessage } from "./errors.js";
import type {
  ExecutionObservation,
  RemoteExecutor,
  WorkspaceGeneration,
} from "./remote-executor.js";
import { MAX_EXECUTION_METADATA_BYTES, MAX_EXECUTION_OUTPUT_BYTES } from "./remote-executor.js";
import type { DurableRunRepository, DurableRunState } from "./transition-store.js";
import { decideNext } from "./transitions.js";

/** Provision is idempotent by tenant/run/workspace identity. Inspect never recreates lost files. */
export interface WorkspaceProvider {
  provision(scope: TenantScope, runId: string, workspaceId: string): Promise<WorkspaceGeneration>;
  inspect(scope: TenantScope, workspace: WorkspaceGeneration): Promise<"available" | "lost">;
}
export type TickResult = {
  state: "idle" | "advanced" | "waiting" | "blocked" | "terminal";
  wakeAt?: string;
};
export type DurableRunnerOptions = {
  store: DurableRunRepository;
  executor: RemoteExecutor;
  artifacts: ArtifactStore;
  artifactBytes: number;
  stateBytes?: number;
  workspaces: WorkspaceProvider;
  runtime: RuntimeIdentity;
  runtimeForRun: (runId: string) => Promise<RuntimeIdentity | undefined>;
  now?: () => number;
  leaseMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const terminal = (run: RunRecord) =>
  run.status === "succeeded" || run.status === "failed" || run.status === "interrupted";

/** Each tick performs a bounded graph transition or remote observation. No lease spans
 * an executor or workspace call. A restarted driver reuses persisted attempt identity.
 */
export class DurableRunner {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly stateBytes: number;
  constructor(private readonly options: DurableRunnerOptions) {
    if (options.artifacts.scope.tenantId !== options.store.scope.tenantId)
      throw new Error("Artifact tenant mismatch");
    this.stateBytes = options.stateBytes ?? 512_000;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 10_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    const supported = Math.min(
      MAX_EXECUTION_OUTPUT_BYTES,
      options.executor.maxOutputBytes,
      Math.floor((options.artifactBytes - MAX_EXECUTION_METADATA_BYTES) / 6),
    );
    this.maxOutputBytes = options.maxOutputBytes ?? supported;
    if (
      !Number.isSafeInteger(options.executor.maxOutputBytes) ||
      options.executor.maxOutputBytes < 1 ||
      !Number.isSafeInteger(options.artifactBytes) ||
      supported < 1 ||
      this.maxOutputBytes > supported
    )
      throw new Error("Runner output budget exceeds executor or artifact capacity");
    for (const value of [
      this.leaseMs,
      this.pollMs,
      this.timeoutMs,
      this.maxOutputBytes,
      this.stateBytes,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Runner limits must be positive integers");
    if (this.leaseMs > 60_000) throw new Error("Transition lease exceeds storage limit");
  }

  private later(): TickResult {
    return { state: "waiting", wakeAt: new Date(this.now() + this.pollMs).toISOString() };
  }

  async tick(runId: string): Promise<TickResult> {
    const state = await this.options.store.read(runId);
    if (!state) return { state: "idle" };
    const pinned = await this.options.runtimeForRun(runId);
    if (
      !pinned ||
      pinned.build !== this.options.runtime.build ||
      pinned.graphSchema !== this.options.runtime.graphSchema
    )
      return { state: "blocked" };
    if (state.intent) return await this.reconcile(state);
    if (terminal(state.run)) return { state: "terminal" };
    if (state.cancelRequested)
      return await this.mutate(runId, (current) => {
        if (current.intent) return false;
        current.run.status = "interrupted";
        current.run.error = "Run cancelled before command launch";
      });
    if (state.workspace.state === "lost") return await this.blockWorkspace(runId);
    if (state.workspace.state === "unallocated") {
      if (state.run.options.workspace.kind !== "managed")
        throw new Error("Durable runs require managed workspace");
      const workspace = await this.options.workspaces.provision(
        this.options.store.scope,
        runId,
        state.run.options.workspace.id,
      );
      if (workspace.workspaceId !== state.run.options.workspace.id)
        throw new Error("Provisioned workspace identity mismatch");
      return await this.mutate(runId, (current) => {
        if (current.workspace.state !== "unallocated" || current.cancelRequested) return false;
        current.workspace = { state: "available", workspace };
      });
    }
    const workspace = state.workspace.workspace;
    const available = await this.options.workspaces.inspect(this.options.store.scope, workspace);
    if (available === "lost") return await this.blockWorkspace(runId, workspace);
    const attempts = await hydrateAttempts(state.attempts, this.options.artifacts);
    let decision: ReturnType<typeof decideNext> | undefined;
    let decisionError: string | undefined;
    try {
      decision = decideNext(state.run.workflow, state.run.input, attempts, {
        resume: false,
        retryUncertain: false,
      });
    } catch (error) {
      decisionError = errorMessage(error);
    }
    if (
      decision?.kind === "command" &&
      (decision.command.maxOutputBytes ?? this.maxOutputBytes) > this.maxOutputBytes
    ) {
      decision = undefined;
      decisionError = "Command output budget exceeds configured execution capacity";
    }
    const command =
      decision?.kind === "command"
        ? {
            ...decision.command,
            timeoutMs: Math.min(decision.command.timeoutMs ?? this.timeoutMs, this.timeoutMs),
            maxOutputBytes: Math.min(
              decision.command.maxOutputBytes ?? this.maxOutputBytes,
              this.maxOutputBytes,
            ),
          }
        : undefined;
    let commandArtifact: import("../application/ports.js").ArtifactIdentity | undefined;
    try {
      if (command) commandArtifact = await putExecutionArtifact(this.options.artifacts, command);
    } catch {
      decision = undefined;
      decisionError = "Resolved command exceeds execution artifact limits";
    }
    return await this.mutate(runId, async (current) => {
      if (
        current.revision !== state.revision ||
        current.intent ||
        current.cancelRequested ||
        current.workspace.state !== "available" ||
        !sameWorkspace(current.workspace.workspace, workspace)
      )
        return false;
      if (!decision) {
        current.run.status = "failed";
        current.run.error = decisionError;
        return;
      }
      if (decision.kind === "done") {
        current.run.status = "succeeded";
        return;
      }
      if (decision.kind === "blocked") {
        current.run.status = decision.status;
        current.run.error = decision.error;
        return;
      }
      if (decision.kind === "reconcile") {
        current.run.status = "interrupted";
        current.run.error = "Running attempt has no persisted execution intent";
        return;
      }
      const attempt: AttemptRecord = {
        id: crypto.randomUUID(),
        runId,
        nodeId: decision.nodeId,
        number:
          1 +
          Math.max(
            0,
            ...current.attempts
              .filter((item) => item.nodeId === decision.nodeId)
              .map((item) => item.number),
          ),
        status: decision.kind === "condition" ? "succeeded" : "running",
        input:
          decision.kind === "condition"
            ? { test: decision.test ?? null }
            : (decision.command as Json),
        startedAt: new Date(this.now()).toISOString(),
      };
      current.attempts.push(attempt);
      current.run.status = "running";
      if (decision.kind === "condition") {
        attempt.output = { branch: decision.branch };
        attempt.endedAt = attempt.startedAt;
        return;
      }
      if (!command || !commandArtifact) throw new Error("Resolved command artifact missing");
      const deadline = new Date(this.now() + command.timeoutMs).toISOString();
      const key = { tenantId: this.options.store.scope.tenantId, runId, attemptId: attempt.id };
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ command, workspace, deadline })),
      );
      attempt.input = { $resolvedCommand: commandArtifact } as Json;
      current.intent = {
        key,
        commandArtifact,
        workspace,
        deadline,
        fingerprint: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
    });
  }

  private async blockWorkspace(
    runId: string,
    workspace?: WorkspaceGeneration,
  ): Promise<TickResult> {
    return await this.mutate(runId, (current) => {
      if (
        workspace &&
        current.workspace.state === "available" &&
        sameWorkspace(current.workspace.workspace, workspace)
      )
        current.workspace = {
          state: "lost",
          workspace,
          reason: "Workspace generation unavailable",
        };
      if (current.workspace.state !== "lost") return false;
      current.run.status = "interrupted";
      current.run.error = "Workspace lost. Restore its durable checkpoint before resuming.";
    });
  }

  private async reconcile(snapshot: DurableRunState): Promise<TickResult> {
    const persisted = snapshot.intent;
    if (!persisted) return this.later();
    const intent =
      "command" in persisted
        ? persisted
        : {
            ...persisted,
            command: await getExecutionArtifact<import("../core/model.js").ResolvedCommand>(
              this.options.artifacts,
              persisted.commandArtifact,
            ),
          };
    let observation: ExecutionObservation;
    if (snapshot.cancelRequested) {
      observation = await this.options.executor.cancel(intent.key);
    } else {
      observation = await this.options.executor.inspect(intent.key);
      if (observation.state === "not-started") {
        // A fresh cancellation read precedes start. The executor's tombstone fences concurrent cancellation.
        const current = await this.options.store.read(snapshot.run.id);
        if (!current || terminal(current.run) || current.intent?.fingerprint !== intent.fingerprint)
          return this.later();
        if (current.cancelRequested || this.now() >= Date.parse(intent.deadline))
          observation = await this.options.executor.cancel(intent.key);
        else observation = await this.options.executor.start(intent);
      }
    }
    if (observation.state === "running") return this.later();
    if (observation.state === "not-started") return this.later();
    const outputArtifact =
      observation.state === "completed"
        ? await putExecutionArtifact(this.options.artifacts, observation.output)
        : undefined;
    return await this.mutate(
      snapshot.run.id,
      (current) => {
        if (
          current.intent?.key.attemptId !== intent.key.attemptId ||
          current.intent.fingerprint !== intent.fingerprint
        )
          return false;
        const attempt = current.attempts.find((item) => item.id === intent.key.attemptId);
        if (!attempt || (attempt.status !== "running" && attempt.status !== "uncertain"))
          return false;
        attempt.endedAt = new Date(this.now()).toISOString();
        if (
          observation.state === "completed" &&
          sameWorkspace(observation.workspace, intent.workspace) &&
          !current.cancelRequested &&
          new TextEncoder().encode(observation.output.stdout).byteLength +
            new TextEncoder().encode(observation.output.stderr).byteLength <=
            (intent.command.maxOutputBytes ?? this.maxOutputBytes)
        ) {
          attempt.output = { $commandOutput: outputArtifact } as Json;
          current.run.status = "running";
          current.run.error = undefined;
          attempt.error = undefined;
          attempt.status = observation.output.exitCode === 0 ? "succeeded" : "failed";
          if (attempt.status === "failed") {
            attempt.error = `Command exited with code ${observation.output.exitCode}`;
            current.run.status = "failed";
            current.run.error = attempt.error;
          }
        } else {
          attempt.status =
            observation.state === "cancelled-before-start" ? "cancelled" : "uncertain";
          attempt.error =
            observation.state === "unknown"
              ? observation.reason
              : "Command interrupted; external effects may remain";
          current.run.status = "interrupted";
          current.run.error = attempt.error;
        }
        if (observation.state === "completed" || observation.state === "cancelled-before-start")
          current.intent = undefined;
      },
      true,
    );
  }

  private async mutate(
    runId: string,
    change: (state: DurableRunState) => undefined | false | Promise<undefined | false>,
    reconcile = false,
  ): Promise<TickResult> {
    const lease = await this.options.store.acquire(runId, crypto.randomUUID(), this.leaseMs);
    if (!lease) return this.later();
    try {
      let current = await this.options.store.read(runId);
      if (!current || (terminal(current.run) && !reconcile))
        return { state: current ? "terminal" : "idle" };
      const original = structuredClone(current);
      if ((await change(current)) === false) return this.later();
      current.run.updatedAt = new Date(this.now()).toISOString();
      if (new TextEncoder().encode(JSON.stringify(current)).byteLength > this.stateBytes - 2048) {
        current = original;
        current.run.status = "interrupted";
        current.run.error =
          "Execution history reached its storage limit. No new command was launched.";
      }
      if (!(await this.options.store.commit(lease, current.revision, current))) return this.later();
      return current.intent && current.run.status === "interrupted"
        ? { state: "blocked", wakeAt: new Date(this.now() + this.pollMs).toISOString() }
        : terminal(current.run)
          ? { state: "terminal" }
          : { state: "advanced", wakeAt: new Date(this.now()).toISOString() };
    } finally {
      await this.options.store.release(lease);
    }
  }
}

function sameWorkspace(left: WorkspaceGeneration, right: WorkspaceGeneration): boolean {
  return left.workspaceId === right.workspaceId && left.generation === right.generation;
}
