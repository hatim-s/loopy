import type { EngineLog, EngineRun, EngineRunStatus, EngineStep, Json } from "../core/index.js";
import { OwnershipError, type RunStore } from "./store.js";

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, EngineRun>();
  private readonly steps = new Map<string, Map<number, EngineStep>>();
  private readonly logs = new Map<string, Map<number, EngineLog>>();

  constructor(private readonly now: () => number = Date.now) {}

  async createRun(run: EngineRun): Promise<void> {
    if (this.runs.has(run.id)) {
      throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
    }

    this.runs.set(run.id, structuredClone(run));
  }

  async getRun(id: string): Promise<EngineRun | undefined> {
    return structuredClone(this.runs.get(id));
  }

  async listRuns(filter: { slug?: string; status?: EngineRunStatus } = {}): Promise<EngineRun[]> {
    return structuredClone(
      [...this.runs.values()].filter(
        (run) =>
          (filter.slug === undefined || run.slug === filter.slug) &&
          (filter.status === undefined || run.status === filter.status),
      ),
    );
  }

  async claim(runId: string, token: string): Promise<EngineRun> {
    const run = this.requireRun(runId);

    if (run.ownerToken !== undefined) {
      throw new OwnershipError(runId);
    }

    if (run.status !== "queued" && run.status !== "suspended") {
      throw new Error(
        `Run '${runId}' cannot be claimed in status '${run.status}'. Activate a queued or suspended run.`,
      );
    }

    run.ownerToken = token;
    run.status = "running";
    run.heartbeatAt = this.timestamp();
    run.updatedAt = this.timestamp();
    delete run.wakeAt;

    return structuredClone(run);
  }

  async heartbeat(runId: string, token: string): Promise<boolean> {
    const run = this.owned(runId, token);
    run.heartbeatAt = this.timestamp();
    run.updatedAt = this.timestamp();

    return true;
  }

  async suspend(runId: string, token: string, wakeAt?: string): Promise<void> {
    const run = this.owned(runId, token);
    run.status = "suspended";
    run.wakeAt = wakeAt;
    run.updatedAt = this.timestamp();
  }

  async finishRun(
    runId: string,
    token: string,
    status: "succeeded" | "failed" | "cancelled",
    output?: Json,
    error?: string,
  ): Promise<void> {
    const run = this.owned(runId, token);
    run.status = status;
    run.output = structuredClone(output);
    run.error = error;
    delete run.wakeAt;
    run.updatedAt = this.timestamp();
  }

  async release(runId: string, token: string): Promise<void> {
    const run = this.owned(runId, token);
    delete run.ownerToken;
    delete run.ownerPid;
    delete run.ownerHost;
    delete run.heartbeatAt;
    run.updatedAt = this.timestamp();
  }

  async getSteps(runId: string): Promise<EngineStep[]> {
    return structuredClone(
      [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
    );
  }

  async putStep(runId: string, token: string, step: EngineStep): Promise<void> {
    this.owned(runId, token);

    if (step.runId !== runId) {
      throw new Error("Step belongs to another run. Supply the claimed run ID.");
    }

    const steps = this.steps.get(runId) ?? new Map<number, EngineStep>();
    steps.set(step.seq, structuredClone(step));
    this.steps.set(runId, steps);
  }

  async appendLog(runId: string, token: string, log: EngineLog): Promise<void> {
    this.owned(runId, token);

    if (log.runId !== runId) {
      throw new Error("Log belongs to another run. Supply the claimed run ID.");
    }

    const logs = this.logs.get(runId) ?? new Map<number, EngineLog>();

    if (!logs.has(log.seq)) {
      logs.set(log.seq, structuredClone(log));
    }

    this.logs.set(runId, logs);
  }

  async getLogs(runId: string, after = 0): Promise<EngineLog[]> {
    return structuredClone(
      [...(this.logs.get(runId)?.values() ?? [])]
        .filter((log) => log.seq > after)
        .sort((a, b) => a.seq - b.seq),
    );
  }

  async dueRuns(now: string): Promise<EngineRun[]> {
    return structuredClone(
      [...this.runs.values()].filter(
        (run) =>
          run.ownerToken === undefined &&
          (run.status === "queued" ||
            (run.status === "suspended" &&
              run.wakeAt !== undefined &&
              Date.parse(run.wakeAt) <= Date.parse(now))),
      ),
    );
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private requireRun(runId: string): EngineRun {
    const run = this.runs.get(runId);

    if (!run) {
      throw new Error(`Run '${runId}' does not exist. Create the run first.`);
    }

    return run;
  }

  private owned(runId: string, token: string): EngineRun {
    const run = this.requireRun(runId);

    if (run.ownerToken !== token) {
      throw new OwnershipError(runId);
    }

    return run;
  }
}
