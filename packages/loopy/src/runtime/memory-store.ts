import type {
  HookRecord,
  Json,
  LogRecord,
  RunOutcome,
  RunRecord,
  RunSnapshot,
  RunStatus,
  RuntimeEvent,
  RuntimeEventChange,
  Schedule,
  StepRecord,
  WaitingHookStep,
} from "../core/index.js";
import { canResolveHook, earliestWake } from "./hook-state.js";
import { acquireWindow, type RateLimitResult, type RateLimitWindow } from "./rate-limit.js";
import { sameStepRecord } from "./step-record.js";
import { OwnershipError, type RunStore } from "./store.js";

type EventTransaction = { id: string; events: RuntimeEvent[] };

export class MemoryRunStore implements RunStore {
  private readonly hooks = new Map<string, HookRecord>();
  private readonly hooksByRun = new Map<string, Map<number, HookRecord>>();

  async createHook(runId: string, token: string, step: WaitingHookStep): Promise<void> {
    return this.commit((txn) => {
      this.requireRunning(this.owned(runId, token));

      if (this.hooks.has(step.input.token) || this.steps.get(runId)?.has(step.seq)) {
        throw new Error("Hook already exists. Resume the run to use its waiting hook.");
      }

      const steps = this.steps.get(runId) ?? new Map<number, StepRecord>();
      const record = structuredClone({ ...step, runId });
      steps.set(step.seq, record);
      this.steps.set(runId, steps);

      const hook = {
        ...step.input,
        runId,
        seq: step.seq,
        createdAt: step.startedAt,
      };

      this.hooks.set(step.input.token, hook);
      const hooks = this.hooksByRun.get(runId) ?? new Map<number, HookRecord>();
      hooks.set(step.seq, hook);
      this.hooksByRun.set(runId, hooks);
      this.emit(txn, {
        entity: "step",
        kind: "waiting",
        runId,
        record,
      });
      this.emit(txn, { entity: "hook", kind: "created", runId, record: hook });
    });
  }

  async resolveHook(token: string, payload: Json): Promise<boolean> {
    return this.commit((txn) => {
      const hook = this.hooks.get(token);
      const run = hook ? this.runs.get(hook.runId) : undefined;
      const steps = hook ? this.steps.get(hook.runId) : undefined;
      const step = hook ? steps?.get(hook.seq) : undefined;

      if (
        !hook ||
        hook.resolvedAt !== undefined ||
        hook.expiredAt !== undefined ||
        !run ||
        !step ||
        !canResolveHook(run, step, this.now())
      ) {
        return false;
      }

      const timestamp = this.timestamp();
      hook.payload = structuredClone(payload);
      hook.resolvedAt = timestamp;
      run.wakeAt = timestamp;
      run.updatedAt = timestamp;
      this.emit(txn, { entity: "hook", kind: "resolved", runId: run.id, record: hook });
      this.emit(txn, { entity: "run", kind: "woken", runId: run.id, record: run });

      return true;
    });
  }

  async listHooks(runId: string): Promise<HookRecord[]> {
    return structuredClone(
      [...(this.hooksByRun.get(runId)?.values() ?? [])].sort((left, right) => left.seq - right.seq),
    );
  }

  async listPendingHooks(runId: string, seqs: number[]): Promise<HookRecord[]> {
    const hooks = seqs.flatMap((seq) => {
      const hook = this.hooksByRun.get(runId)?.get(seq);

      return hook ? [hook] : [];
    });

    return structuredClone(hooks);
  }

  async expireHook(runId: string, token: string, seq: number): Promise<string | undefined> {
    return this.commit((txn) => {
      this.requireRunning(this.owned(runId, token));
      const hook = this.hooksByRun.get(runId)?.get(seq);
      const step = this.steps.get(runId)?.get(seq);

      if (
        !hook ||
        hook.resolvedAt !== undefined ||
        step?.status !== "waiting" ||
        step.wakeAt === undefined ||
        Date.parse(step.wakeAt) > this.now()
      ) {
        return undefined;
      }

      if (hook.expiredAt === undefined) {
        hook.expiredAt = this.timestamp();
        this.emit(txn, { entity: "hook", kind: "expired", runId, record: hook });
      }

      return step.wakeAt;
    });
  }

  private readonly limits = new Map<string, RateLimitWindow>();

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

  private readonly schedules = new Map<string, Schedule>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly steps = new Map<string, Map<number, StepRecord>>();
  private readonly logs = new Map<string, Map<number, LogRecord>>();

  constructor(
    private readonly now: () => number = Date.now,
    readonly leaseMs = 60_000,
  ) {}

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

      if (run.status !== "queued" && run.status !== "suspended" && !this.stale(run, this.now())) {
        throw new Error(
          `Run '${runId}' cannot be claimed in status '${run.status}'. Activate a queued or suspended run.`,
        );
      }

      const timestamp = this.timestamp();

      if (run.owner) {
        this.recoverSteps(txn, runId, timestamp);
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

      const resolved = [...(this.hooksByRun.get(runId)?.values() ?? [])]
        .filter((hook) => this.steps.get(runId)?.get(hook.seq)?.status === "waiting")
        .flatMap((hook) => (hook.resolvedAt === undefined ? [] : [hook.resolvedAt]))
        .sort()[0];

      const wake = earliestWake(resolved, wakeAt);
      delete run.wakeAt;

      if (wake !== undefined) {
        run.wakeAt = wake;
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

  private dropOwner(txn: EventTransaction, run: RunRecord): void {
    const timestamp = this.timestamp();

    if (run.status === "running") {
      run.status = "suspended";
      run.wakeAt = timestamp;
    }

    delete run.owner;
    run.updatedAt = timestamp;
    this.emit(txn, { entity: "run", kind: "released", runId: run.id, record: run });
  }

  private recoverSteps(txn: EventTransaction, runId: string, timestamp: string): void {
    const steps = this.steps.get(runId);

    for (const [seq, step] of [...(steps ?? [])].sort(([left], [right]) => left - right)) {
      if (step.status !== "running") {
        continue;
      }

      const recovered: StepRecord = {
        ...step,
        status: "retrying",
        error: "Runner lost ownership. Retrying unfinished step.",
        nextRetryAt: timestamp,
        endedAt: timestamp,
      };

      steps?.set(seq, recovered);
      this.emit(txn, { entity: "step", kind: "retrying", runId, record: recovered });
    }
  }

  async getSteps(runId: string): Promise<StepRecord[]> {
    return structuredClone(
      [...(this.steps.get(runId)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
    );
  }

  async putStep(runId: string, token: string, step: StepRecord): Promise<void> {
    return this.commit((txn) => {
      this.owned(runId, token);
      const steps = this.steps.get(runId) ?? new Map<number, StepRecord>();
      const record = structuredClone({ ...step, runId });

      if (sameStepRecord(steps.get(step.seq), record)) {
        return;
      }

      steps.set(step.seq, record);
      this.steps.set(runId, steps);
      this.emit(txn, { entity: "step", kind: record.status, runId, record });
    });
  }

  async appendLog(runId: string, token: string, log: LogRecord): Promise<void> {
    return this.commit((txn) => {
      this.owned(runId, token);

      const logs = this.logs.get(runId) ?? new Map<number, LogRecord>();

      if (logs.has(log.seq)) {
        throw new Error(`Log sequence ${log.seq} already exists. Append a new sequence number.`);
      }

      const record = structuredClone({ ...log, runId });
      logs.set(log.seq, record);

      this.logs.set(runId, logs);
      this.emit(txn, { entity: "log", kind: "written", runId, record });
    });
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
    return this.commit((txn) => {
      const record = structuredClone({
        ...schedule,
        nextFireAt: new Date(schedule.nextFireAt).toISOString(),
      });

      this.schedules.set(JSON.stringify([schedule.workspace, schedule.slug]), record);
      this.emit(txn, { entity: "schedule", kind: "saved", runId: null, record });
    });
  }

  async listSchedules(): Promise<Schedule[]> {
    return structuredClone([...this.schedules.values()]);
  }

  async deleteSchedule(workspace: string, slug: string): Promise<void> {
    return this.commit((txn) => {
      if (this.schedules.delete(JSON.stringify([workspace, slug]))) {
        this.emit(txn, {
          entity: "schedule",
          kind: "deleted",
          runId: null,
          record: { workspace, slug },
        });
      }
    });
  }

  async fireSchedule(
    workspace: string,
    slug: string,
    fireKey: string,
    run: RunRecord,
    nextFireAt: string,
  ): Promise<boolean> {
    return this.commit((txn) => {
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
      this.emit(txn, { entity: "run", kind: "created", runId: run.id, record: savedRun });
      this.emit(txn, { entity: "schedule", kind: "fired", runId: null, record: schedule });

      return true;
    });
  }

  private eventLog: RuntimeEvent[] = [];
  private sequence = 0;
  private readonly storeEpoch = crypto.randomUUID();
  private readonly listeners = new Set<(events: RuntimeEvent[]) => void>();

  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async events(after: number, limit: number): Promise<RuntimeEvent[]> {
    return structuredClone(this.eventLog.filter((event) => event.sequence > after).slice(0, limit));
  }

  async epoch(): Promise<string> {
    return this.storeEpoch;
  }

  async snapshotRun(id: string): Promise<RunSnapshot | undefined> {
    const run = this.runs.get(id);

    if (!run) {
      return undefined;
    }

    return structuredClone({
      run,
      steps: [...(this.steps.get(id)?.values() ?? [])].sort((left, right) => left.seq - right.seq),
      logs: [...(this.logs.get(id)?.values() ?? [])].sort((left, right) => left.seq - right.seq),
      hooks: [...(this.hooksByRun.get(id)?.values() ?? [])].sort(
        (left, right) => left.seq - right.seq,
      ),
      cursor: this.sequence,
      epoch: this.storeEpoch,
    });
  }

  async pruneEvents(now: string): Promise<number> {
    const cutoff = Date.parse(now) - 86_400_000;
    const kept = this.eventLog.slice(-100_000).filter((event) => Date.parse(event.at) >= cutoff);
    const deleted = this.eventLog.length - kept.length;
    this.eventLog = kept;

    return deleted;
  }

  private commit<T>(change: (txn: EventTransaction) => T): T {
    const txn: EventTransaction = { id: crypto.randomUUID(), events: [] };
    const result = change(txn);
    this.eventLog.push(...txn.events);

    if (txn.events.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(txn.events));
        } catch {
          continue;
        }
      }
    }

    return result;
  }

  private emit(txn: EventTransaction, change: RuntimeEventChange): void {
    txn.events.push(
      structuredClone({ ...change, sequence: ++this.sequence, at: this.timestamp(), txn: txn.id }),
    );
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
