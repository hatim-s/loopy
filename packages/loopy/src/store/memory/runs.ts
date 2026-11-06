import type { RunOutcome, RunRecord, RunStatus } from "../../core";
import { acquireWindow, isTerminalRun, OwnershipError } from "../../core";
import { type EventTransaction } from "../event-outbox";
import { ownedStorageOperation, StoreRejectedError, storageOperation } from "../operation";
import { normalizeRun, utc } from "../timestamps";
import { publicHook } from "../wait";
import { MemoryEvents } from "./events";

export class MemoryRuns extends MemoryEvents {
  acquireRateLimit(key: string, count: number, windowMs: number, now: string) {
    return storageOperation("acquireRateLimit", () => {
      const acquired = acquireWindow(this.limits.get(key), count, windowMs, now);
      this.limits.set(key, acquired.window);

      return acquired.result;
    });
  }

  createRun(run: RunRecord) {
    return storageOperation("createRun", () => {
      return this.commit((txn) => {
        if (this.runs.has(run.id)) {
          throw new StoreRejectedError(`Run '${run.id}' already exists. Use a new run ID.`);
        }

        const record = structuredClone(normalizeRun(run));
        this.runs.set(run.id, record);
        this.emit(txn, { entity: "run", kind: "created", runId: run.id, record });
      });
    });
  }

  getRun(id: string) {
    return storageOperation("getRun", () => {
      return structuredClone(this.runs.get(id));
    });
  }

  listRuns(filter: { slug?: string; status?: RunStatus } = {}) {
    return storageOperation("listRuns", () => {
      return structuredClone(
        [...this.runs.values()].filter(
          (run) =>
            (filter.slug === undefined || run.slug === filter.slug) &&
            (filter.status === undefined || run.status === filter.status),
        ),
      );
    });
  }

  claim(runId: string, token: string) {
    return ownedStorageOperation("claim", () => {
      return this.commit((txn) => {
        const run = this.requireRun(runId);

        if (run.owner !== undefined && !this.stale(run, this.now())) {
          throw new OwnershipError(runId);
        }

        if (run.status !== "queued" && run.status !== "suspended" && run.status !== "running") {
          throw new StoreRejectedError(
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
    });
  }

  wakeRun(id: string, at: string) {
    return storageOperation("wakeRun", () => {
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

        run.wakeAt = utc(at);
        run.updatedAt = utc(at);
        this.emit(txn, { entity: "run", kind: "woken", runId: id, record: run });

        return undefined;
      });
    });
  }

  heartbeat(runId: string, token: string) {
    return storageOperation("heartbeat", () => {
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
    });
  }

  suspend(runId: string, token: string, wakeAt?: string) {
    return ownedStorageOperation("suspend", () => {
      return this.commit((txn) => {
        const run = this.owned(runId, token);
        this.requireRunning(run);
        run.status = "suspended";

        delete run.wakeAt;

        if (wakeAt !== undefined) {
          run.wakeAt = utc(wakeAt);
        }

        run.updatedAt = this.timestamp();
        this.emit(txn, { entity: "run", kind: "suspended", runId, record: run });
      });
    });
  }

  finishRun(runId: string, token: string, outcome: RunOutcome) {
    return ownedStorageOperation("finishRun", () => {
      return this.commit((txn) => {
        const run = this.owned(runId, token);
        this.requireRunning(run);
        this.expireWaits(txn, runId, this.timestamp());
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
    });
  }

  release(runId: string, token: string) {
    return ownedStorageOperation("release", () => {
      return this.commit((txn) => {
        const run = this.owned(runId, token);
        const wasRunning = run.status === "running";
        this.dropOwner(txn, run);

        if (wasRunning) {
          this.emit(txn, { entity: "run", kind: "suspended", runId, record: run });
        }
      });
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

  dueRuns(now: string) {
    return storageOperation("dueRuns", () => {
      return structuredClone(
        [...this.runs.values()]
          .filter(
            (run) =>
              this.stale(run, Date.parse(now)) ||
              (run.owner === undefined &&
                (run.status === "queued" ||
                  run.status === "running" ||
                  (run.status === "suspended" &&
                    run.wakeAt !== undefined &&
                    Date.parse(run.wakeAt) <= Date.parse(now)))),
          )
          .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
      );
    });
  }

  nextWakeAt() {
    return storageOperation("nextWakeAt", () => {
      const wakes = [...this.runs.values()]
        .filter((run) => run.status === "suspended" && run.owner === undefined)
        .flatMap((run) => (run.wakeAt === undefined ? [] : [run.wakeAt]));

      wakes.sort((left, right) => Date.parse(left) - Date.parse(right));

      return wakes[0] === undefined ? undefined : utc(wakes[0]);
    });
  }

  protected expireWaits(txn: EventTransaction, runId: string, at: string): void {
    for (const wait of this.waits.values()) {
      if (wait.runId === runId && !wait.resolvedAt && !wait.expiredAt) {
        wait.expiredAt = utc(at);
        this.emit(txn, { entity: "hook", kind: "expired", runId, record: publicHook(wait) });
      }
    }
  }

  protected stale(run: RunRecord, now: number): boolean {
    return (
      (run.status === "running" || run.status === "suspended") &&
      run.owner !== undefined &&
      now - Date.parse(run.owner.heartbeatAt) > this.leaseMs
    );
  }

  protected requireRunning(run: RunRecord): void {
    if (run.status !== "running") {
      throw new StoreRejectedError(
        `Run '${run.id}' cannot transition from '${run.status}'. Claim a queued or suspended run first.`,
      );
    }
  }

  protected requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);

    if (!run) {
      throw new StoreRejectedError(`Run '${runId}' does not exist. Create the run first.`);
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
