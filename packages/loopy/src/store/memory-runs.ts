import type { RunOutcome, RunRecord, RunStatus, WakeError } from "../core/index.js";
import {
  acquireWindow,
  isTerminalRun,
  OwnershipError,
  type RateLimitResult,
} from "../core/index.js";
import { type EventTransaction } from "./event-outbox.js";
import { MemoryEvents } from "./memory-events.js";

export class MemoryRuns extends MemoryEvents {
  async acquireRateLimit(
    key: string,
    count: number,
    windowMs: number,
    now: string,
  ): Promise<RateLimitResult> {
    const acquired = acquireWindow(this.limits.get(key), count, windowMs, now);
    this.limits.set(key, acquired.window);

    return acquired.result;
  }

  async createRun(run: RunRecord): Promise<void> {
    return this.commit((txn) => {
      if (this.runs.has(run.id)) {
        throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
      }

      this.runs.set(run.id, structuredClone(run));
      this.emit(txn, { entity: "run", kind: "created", runId: run.id, record: run });
    });
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
    return this.commit((txn) => {
      const run = this.requireRun(runId);

      if (run.owner !== undefined && !this.stale(run, this.now())) {
        throw new OwnershipError(runId);
      }

      if (run.status !== "queued" && run.status !== "suspended" && run.status !== "running") {
        throw new Error(
          `Run '${runId}' cannot be claimed in status '${run.status}'. Activate a queued or suspended run.`,
        );
      }

      const timestamp = this.timestamp();

      if (run.owner) {
        this.dropOwner(txn, run);
      }

      run.owner = { token, pid: 0, host: "memory", heartbeatAt: timestamp };
      run.status = "running";
      run.updatedAt = timestamp;
      delete run.wakeAt;

      this.emit(txn, { entity: "run", kind: "claimed", runId, record: run });

      return structuredClone(run);
    });
  }

  async wakeRun(id: string, at: string): Promise<WakeError | undefined> {
    return this.commit((txn) => {
      const run = this.runs.get(id);

      if (!run) {
        return "not_found";
      }

      if (run.owner) {
        if (!this.stale(run, this.now())) {
          return "owned_elsewhere";
        }

        this.dropOwner(txn, run);
      }

      if (isTerminalRun(run.status)) {
        return "not_claimable";
      }

      run.wakeAt = at;
      run.updatedAt = at;
      this.emit(txn, { entity: "run", kind: "woken", runId: id, record: run });

      return undefined;
    });
  }

  async heartbeat(runId: string, token: string): Promise<boolean> {
    return this.commit((txn) => {
      const run = this.requireRun(runId);

      if (run.owner?.token !== token) {
        return false;
      }

      run.owner.heartbeatAt = this.timestamp();
      run.updatedAt = run.owner.heartbeatAt;
      this.emit(txn, { entity: "run", kind: "heartbeat", runId, record: run });

      return true;
    });
  }

  async suspend(runId: string, token: string, wakeAt?: string): Promise<void> {
    return this.commit((txn) => {
      const run = this.owned(runId, token);
      this.requireRunning(run);
      run.status = "suspended";

      delete run.wakeAt;

      if (wakeAt !== undefined) {
        run.wakeAt = wakeAt;
      }

      run.updatedAt = this.timestamp();
      this.emit(txn, { entity: "run", kind: "suspended", runId, record: run });
    });
  }

  async finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void> {
    return this.commit((txn) => {
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
      this.emit(txn, { entity: "run", kind: "finished", runId, record: run });
    });
  }

  async release(runId: string, token: string): Promise<void> {
    return this.commit((txn) => {
      const run = this.owned(runId, token);
      const wasRunning = run.status === "running";
      this.dropOwner(txn, run);

      if (wasRunning) {
        this.emit(txn, { entity: "run", kind: "suspended", runId, record: run });
      }
    });
  }

  protected dropOwner(txn: EventTransaction, run: RunRecord): void {
    const timestamp = this.timestamp();

    if (run.status === "running") {
      run.status = "suspended";
      run.wakeAt = timestamp;
    }

    delete run.owner;
    run.updatedAt = timestamp;
    this.emit(txn, { entity: "run", kind: "released", runId: run.id, record: run });
  }

  async dueRuns(now: string): Promise<RunRecord[]> {
    return structuredClone(
      [...this.runs.values()].filter(
        (run) =>
          this.stale(run, Date.parse(now)) ||
          (run.owner === undefined &&
            (run.status === "queued" ||
              run.status === "running" ||
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

  protected stale(run: RunRecord, now: number): boolean {
    return (
      run.status === "running" &&
      run.owner !== undefined &&
      now - Date.parse(run.owner.heartbeatAt) > this.leaseMs
    );
  }

  protected requireRunning(run: RunRecord): void {
    if (run.status !== "running") {
      throw new Error(
        `Run '${run.id}' cannot transition from '${run.status}'. Claim a queued or suspended run first.`,
      );
    }
  }

  protected requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);

    if (!run) {
      throw new Error(`Run '${runId}' does not exist. Create the run first.`);
    }

    return run;
  }

  protected owned(runId: string, token: string): RunRecord {
    const run = this.requireRun(runId);

    if (run.owner?.token !== token) {
      throw new OwnershipError(runId);
    }

    return run;
  }
}
