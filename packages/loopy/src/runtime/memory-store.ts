import type {
  LogRecord,
  RunOutcome,
  RunRecord,
  RunStatus,
  Schedule,
  StepRecord,
} from "../core/index.js";
import { OwnershipError, type RunStore } from "./store.js";

export class MemoryRunStore implements RunStore {
  private readonly schedules = new Map<string, Schedule>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly steps = new Map<string, Map<number, StepRecord>>();
  private readonly logs = new Map<string, Map<number, LogRecord>>();

  constructor(
    private readonly now: () => number = Date.now,
    readonly leaseMs = 60_000,
  ) {}

  async createRun(run: RunRecord): Promise<void> {
    if (this.runs.has(run.id)) {
      throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
    }

    this.runs.set(run.id, structuredClone(run));
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return structuredClone(this.runs.get(id));
  }

  async listRuns(filter: { slug?: string; status?: RunStatus } = {}): Promise<RunRecord[]> {
    return structuredClone(
      [...this.runs.values()].filter(
        (run) =>
          (filter.slug === undefined || run.slug === filter.slug) &&
          (filter.status === undefined || run.status === filter.status),
      ),
    );
  }

  async claim(runId: string, token: string): Promise<RunRecord> {
    const run = this.requireRun(runId);

    if (run.owner !== undefined && !this.stale(run, this.now())) {
      throw new OwnershipError(runId);
    }

    if (run.status !== "queued" && run.status !== "suspended" && !this.stale(run, this.now())) {
      throw new Error(
        `Run '${runId}' cannot be claimed in status '${run.status}'. Activate a queued or suspended run.`,
      );
    }

    const timestamp = this.timestamp();

    if (run.owner) {
      for (const [seq, step] of this.steps.get(runId) ?? []) {
        if (step.status === "running") {
          this.steps.get(runId)?.set(seq, {
            ...step,
            status: "retrying",
            error: "Runner lost ownership. Retrying unfinished step.",
            nextRetryAt: timestamp,
            endedAt: timestamp,
          });
        }
      }
    }

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

  async getSteps(runId: string): Promise<StepRecord[]> {
    return structuredClone(
      [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
    );
  }

  async putStep(runId: string, token: string, step: StepRecord): Promise<void> {
    this.owned(runId, token);

    const steps = this.steps.get(runId) ?? new Map<number, StepRecord>();
    steps.set(step.seq, structuredClone(step));
    this.steps.set(runId, steps);
  }

  async appendLog(runId: string, token: string, log: LogRecord): Promise<void> {
    this.owned(runId, token);

    const logs = this.logs.get(runId) ?? new Map<number, LogRecord>();

    if (logs.has(log.seq)) {
      throw new Error(`Log sequence ${log.seq} already exists. Append a new sequence number.`);
    }

    logs.set(log.seq, structuredClone(log));

    this.logs.set(runId, logs);
  }

  async getLogs(runId: string, after = 0): Promise<LogRecord[]> {
    return structuredClone(
      [...(this.logs.get(runId)?.values() ?? [])]
        .filter((log) => log.seq > after)
        .sort((a, b) => a.seq - b.seq),
    );
  }

  async dueRuns(now: string): Promise<RunRecord[]> {
    return structuredClone(
      [...this.runs.values()].filter(
        (run) =>
          this.stale(run, Date.parse(now)) ||
          (run.owner === undefined &&
            (run.status === "queued" ||
              (run.status === "suspended" &&
                run.wakeAt !== undefined &&
                Date.parse(run.wakeAt) <= Date.parse(now)))),
      ),
    );
  }

  async nextWakeAt(): Promise<string | undefined> {
    const wakes = [...this.runs.values()]
      .filter((run) => run.status === "suspended" && run.owner === undefined)
      .flatMap((run) => (run.wakeAt === undefined ? [] : [run.wakeAt]));

    wakes.sort((left, right) => Date.parse(left) - Date.parse(right));

    return wakes[0] === undefined ? undefined : new Date(wakes[0]).toISOString();
  }

  async putSchedule(schedule: Schedule): Promise<void> {
    this.schedules.set(
      JSON.stringify([schedule.workspace, schedule.slug]),
      structuredClone({
        ...schedule,
        nextFireAt: new Date(schedule.nextFireAt).toISOString(),
      }),
    );
  }

  async listSchedules(): Promise<Schedule[]> {
    return structuredClone([...this.schedules.values()]);
  }

  async deleteSchedule(workspace: string, slug: string): Promise<void> {
    this.schedules.delete(JSON.stringify([workspace, slug]));
  }

  async fireSchedule(
    workspace: string,
    slug: string,
    fireKey: string,
    run: RunRecord,
    nextFireAt: string,
  ): Promise<boolean> {
    const schedule = this.schedules.get(JSON.stringify([workspace, slug]));

    if (!schedule) {
      throw new Error(`Schedule '${slug}' does not exist. Save the schedule before firing it.`);
    }

    if (schedule.lastFireKey === fireKey) {
      return false;
    }

    if (this.runs.has(run.id)) {
      throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
    }

    const savedRun = structuredClone(run);
    const next = new Date(nextFireAt).toISOString();
    this.runs.set(run.id, savedRun);
    schedule.lastFireKey = fireKey;
    schedule.nextFireAt = next;

    return true;
  }

  private stale(run: RunRecord, now: number): boolean {
    return (
      run.status === "running" &&
      run.owner !== undefined &&
      now - Date.parse(run.owner.heartbeatAt) > this.leaseMs
    );
  }

  private requireRunning(run: RunRecord): void {
    if (run.status !== "running") {
      throw new Error(
        `Run '${run.id}' cannot transition from '${run.status}'. Claim a queued or suspended run first.`,
      );
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);

    if (!run) {
      throw new Error(`Run '${runId}' does not exist. Create the run first.`);
    }

    return run;
  }

  private owned(runId: string, token: string): RunRecord {
    const run = this.requireRun(runId);

    if (run.owner?.token !== token) {
      throw new OwnershipError(runId);
    }

    return run;
  }
}
