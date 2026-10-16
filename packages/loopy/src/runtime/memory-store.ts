import type {
  EngineLog,
  EngineRun,
  EngineRunStatus,
  EngineStep,
  RunOutcome,
} from "../core/index.js";
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

    if (run.owner !== undefined) {
      throw new OwnershipError(runId);
    }

    if (run.status !== "queued" && run.status !== "suspended") {
      throw new Error(
        `Run '${runId}' cannot be claimed in status '${run.status}'. Activate a queued or suspended run.`,
      );
    }

    const timestamp = this.timestamp();
    run.owner = { token, pid: 0, host: "memory", heartbeatAt: timestamp };
    run.status = "running";
    run.updatedAt = timestamp;
    delete run.wakeAt;

    return structuredClone(run);
  }

  async heartbeat(runId: string, token: string): Promise<boolean> {
    const run = this.requireRun(runId);

    if (run.owner?.token !== token) {
      return false;
    }

    run.owner.heartbeatAt = this.timestamp();
    run.updatedAt = run.owner.heartbeatAt;

    return true;
  }

  async suspend(runId: string, token: string, wakeAt?: string): Promise<void> {
    const run = this.owned(runId, token);
    this.requireRunning(run);
    run.status = "suspended";
    delete run.wakeAt;

    if (wakeAt !== undefined) {
      run.wakeAt = wakeAt;
    }

    run.updatedAt = this.timestamp();
  }

  async finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void> {
    const run = this.owned(runId, token);
    this.requireRunning(run);
    run.status = outcome.status;
    delete run.output;
    delete run.error;

    if (outcome.status === "succeeded") {
      run.output = structuredClone(outcome.output);
    }

    if (outcome.status === "failed") {
      run.error = outcome.error;
    }

    delete run.wakeAt;
    run.updatedAt = this.timestamp();
  }

  async release(runId: string, token: string): Promise<void> {
    const run = this.owned(runId, token);
    const timestamp = this.timestamp();

    if (run.status === "running") {
      run.status = "suspended";
      run.wakeAt = timestamp;
    }

    delete run.owner;
    run.updatedAt = timestamp;
  }

  async getSteps(runId: string): Promise<EngineStep[]> {
    return structuredClone(
      [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
    );
  }

  async putStep(runId: string, token: string, step: EngineStep): Promise<void> {
    this.owned(runId, token);

    const steps = this.steps.get(runId) ?? new Map<number, EngineStep>();
    steps.set(step.seq, structuredClone(step));
    this.steps.set(runId, steps);
  }

  async appendLog(runId: string, token: string, log: EngineLog): Promise<void> {
    this.owned(runId, token);

    const logs = this.logs.get(runId) ?? new Map<number, EngineLog>();

    if (logs.has(log.seq)) {
      throw new Error(`Log sequence ${log.seq} already exists. Append a new sequence number.`);
    }

    logs.set(log.seq, structuredClone(log));

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
          run.owner === undefined &&
          (run.status === "queued" ||
            (run.status === "suspended" &&
              run.wakeAt !== undefined &&
              Date.parse(run.wakeAt) <= Date.parse(now))),
      ),
    );
  }

  private requireRunning(run: EngineRun): void {
    if (run.status !== "running") {
      throw new Error(
        `Run '${run.id}' cannot transition from '${run.status}'. Claim a queued or suspended run first.`,
      );
    }
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

    if (run.owner?.token !== token) {
      throw new OwnershipError(runId);
    }

    return run;
  }
}
