import {
  type AttemptRecord,
  type ExecuteCommand,
  type Json,
  type RunEvent,
  type RunOptions,
  type RunRecord,
  validateSecretBindings,
  validateWorkflow,
  type Workflow,
} from "../core/index.js";
import { Execution } from "./execution.js";
import { assertJson } from "./json.js";
import { Lease } from "./lease.js";
import type { RunRepository } from "./repository.js";

type ExecuteOptions = { retryUncertain?: boolean; resume?: boolean; signal?: AbortSignal };

const DEFAULT_HEARTBEAT_MS = 3_000;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Returns a copy holding only the fields a run may keep, so stray input never reaches storage. */
export function checkRunOptions(options: RunOptions): RunOptions {
  if (options.mode !== "sandbox" && options.mode !== "full") {
    throw new Error(`Execution mode must be sandbox or full, not ${String(options.mode)}.`);
  }
  const workspace = options.workspace;
  if (options.secretBindings !== undefined) {
    validateSecretBindings(options.secretBindings);
    if (workspace?.kind !== "local") {
      throw new Error("Secret bindings require a local workspace.");
    }
  }
  const bindings =
    options.secretBindings === undefined
      ? {}
      : { secretBindings: structuredClone(options.secretBindings) };
  if (workspace?.kind === "local" && typeof workspace.path === "string" && workspace.path) {
    return { workspace: { kind: "local", path: workspace.path }, mode: options.mode, ...bindings };
  }
  if (workspace?.kind === "managed" && typeof workspace.id === "string" && workspace.id) {
    return { workspace: { kind: "managed", id: workspace.id }, mode: options.mode };
  }
  throw new Error("A run needs a local workspace path or a managed workspace id.");
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
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new Error("heartbeatIntervalMs must be a positive integer.");
    }
  }

  /** Freezes the graph, input and options so later edits never reach a run. */
  async createRun(workflow: Workflow, input: Json, options: RunOptions): Promise<RunRecord> {
    validateWorkflow(workflow);
    assertJson(input);
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
    if (run.status !== "running") {
      return run;
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) {
      forwardAbort();
    }
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
      if (lease.lost) {
        throw lease.error;
      }
      outcome = { run: await this.store.finishRun(id, token, result.status, result.error) };
    } catch (error) {
      outcome = { error };
    }
    await lease.stop();
    options.signal?.removeEventListener("abort", forwardAbort);
    try {
      await this.store.release(id, token);
    } catch (error) {
      if ("run" in outcome) {
        outcome = { error };
      }
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.run;
  }
}
