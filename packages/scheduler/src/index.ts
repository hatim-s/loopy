import type {
  CronTrigger,
  JsonObject,
  ManualTrigger,
  MissedRunPolicy,
  OverlapPolicy,
} from "@loopy/contracts";
import { CronExpressionParser } from "cron-parser";

export type SchedulerClock = { now(): Date };
export const systemClock: SchedulerClock = { now: () => new Date() };

export type ScheduleDefinition = {
  schedule: CronTrigger;
  workflowId: string;
  workflowVersion: number;
  manual?: boolean | ManualTrigger;
};

export type ScheduleInvocation = {
  scheduleId: string;
  workflowId: string;
  workflowVersion: number;
  input: JsonObject;
  scheduledFor: string;
  firedAt: string;
  idempotencyKey: string;
  source: "cron" | "manual";
};

export type ScheduleExecution = ScheduleInvocation & { executionId: string };
export type ScheduleState = {
  scheduleId: string;
  nextDueAt?: string;
  active?: ScheduleExecution;
  pending?: ScheduleInvocation;
};

export type SchedulerStore = {
  listSchedules(): Promise<ScheduleDefinition[]>;
  getState(scheduleId: string): Promise<ScheduleState | undefined>;
  saveState(state: ScheduleState): Promise<void>;
  /** Atomically claim a key. False means another tick already claimed it. */
  claimIdempotencyKey(scheduleId: string, key: string): Promise<boolean>;
};

export type SchedulerExecutor = {
  start(invocation: ScheduleInvocation): Promise<{ executionId: string }>;
  cancel(execution: ScheduleExecution, reason: string): Promise<void>;
};

export type ScheduleDecision = {
  scheduleId: string;
  action:
    | "not_due"
    | "disabled"
    | "started"
    | "queued"
    | "skipped_overlap"
    | "cancelled_previous"
    | "duplicate";
  invocation?: ScheduleInvocation;
};

export type TickResult = { at: string; decisions: ScheduleDecision[] };

/** The smallest useful persistence implementation for embedders and tests. */
export class MemorySchedulerStore implements SchedulerStore {
  private readonly states = new Map<string, ScheduleState>();
  private readonly keys = new Set<string>();

  constructor(private readonly schedules: ScheduleDefinition[]) {}

  async listSchedules(): Promise<ScheduleDefinition[]> {
    return this.schedules.map((schedule) => ({ ...schedule, schedule: { ...schedule.schedule } }));
  }

  async getState(scheduleId: string): Promise<ScheduleState | undefined> {
    const state = this.states.get(scheduleId);
    return state ? cloneState(state) : undefined;
  }

  async saveState(state: ScheduleState): Promise<void> {
    this.states.set(state.scheduleId, cloneState(state));
  }

  async claimIdempotencyKey(scheduleId: string, key: string): Promise<boolean> {
    const namespaced = `${scheduleId}:${key}`;
    if (this.keys.has(namespaced)) return false;
    this.keys.add(namespaced);
    return true;
  }
}

export function nextOccurrence(schedule: CronTrigger, after: Date): Date {
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  })
    .next()
    .toDate();
}

export function previousOccurrence(schedule: CronTrigger, before: Date): Date {
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: before,
    tz: schedule.timezone,
  })
    .prev()
    .toDate();
}

/** Inclusive helper used by tests and adapters when inspecting a schedule window. */
export function occurrencesBetween(
  schedule: CronTrigger,
  from: Date,
  through: Date,
  limit = 10_000,
): Date[] {
  if (through < from) return [];
  const occurrences: Date[] = [];
  let cursor = new Date(from.getTime() - 1);
  while (occurrences.length < limit) {
    const next = nextOccurrence(schedule, cursor);
    if (next > through) break;
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}

function cloneState(state: ScheduleState): ScheduleState {
  return JSON.parse(JSON.stringify(state)) as ScheduleState;
}

function manualEnabled(value: ScheduleDefinition["manual"]): boolean {
  if (typeof value === "boolean") return value;
  return value?.enabled ?? true;
}

function iso(date: Date): string {
  return date.toISOString();
}

function stableKey(scheduleId: string, scheduledFor: string, source: "cron" | "manual"): string {
  return source === "cron"
    ? `${scheduleId}:${scheduledFor}`
    : `${scheduleId}:manual:${scheduledFor}`;
}

function inputFor(
  schedule: ScheduleDefinition,
  source: "cron" | "manual",
  override?: JsonObject,
): JsonObject {
  const configured =
    source === "manual" && typeof schedule.manual === "object"
      ? schedule.manual.input
      : schedule.schedule.input;
  return { ...(configured ?? {}), ...(override ?? {}) };
}

/**
 * Local scheduling policy. It only knows about a clock, a state store, and an
 * executor port; persistence and workflow execution remain outside this package.
 */
export class SchedulerEngine {
  constructor(
    private readonly options: {
      store: SchedulerStore;
      executor: SchedulerExecutor;
      clock?: SchedulerClock;
      id?: () => string;
    },
  ) {}

  private now(): Date {
    return this.options.clock?.now() ?? systemClock.now();
  }

  private executionId(): string {
    return this.options.id?.() ?? crypto.randomUUID();
  }

  private async definition(scheduleId: string): Promise<ScheduleDefinition> {
    const schedule = (await this.options.store.listSchedules()).find(
      (item) => item.schedule.scheduleId === scheduleId,
    );
    if (!schedule) throw new Error(`Unknown schedule ${scheduleId}`);
    return schedule;
  }

  private async stateFor(schedule: ScheduleDefinition, at: Date): Promise<ScheduleState> {
    const existing = await this.options.store.getState(schedule.schedule.scheduleId);
    if (existing) return existing;
    // Do not fire an already-past occurrence on the first observation. A
    // boundary tick (exactly on a cron minute) remains inclusive and useful in
    // deterministic tests and one-shot launchers.
    const next =
      at.getUTCSeconds() === 0 && at.getUTCMilliseconds() === 0
        ? nextOccurrence(schedule.schedule, new Date(at.getTime() - 1))
        : nextOccurrence(schedule.schedule, at);
    return { scheduleId: schedule.schedule.scheduleId, nextDueAt: iso(next) };
  }

  private async startInvocation(
    schedule: ScheduleDefinition,
    state: ScheduleState,
    invocation: ScheduleInvocation,
    actionIfActive: ScheduleDecision["action"] = "started",
  ): Promise<ScheduleDecision> {
    if (state.active) {
      const overlap = schedule.schedule.overlap as OverlapPolicy;
      if (overlap === "skip") {
        return { scheduleId: state.scheduleId, action: "skipped_overlap", invocation };
      }
      if (overlap === "queue") {
        if (state.pending)
          return { scheduleId: state.scheduleId, action: "skipped_overlap", invocation };
        state.pending = invocation;
        await this.options.store.saveState(state);
        return { scheduleId: state.scheduleId, action: "queued", invocation };
      }
      await this.options.executor.cancel(state.active, "cancelled by a newer scheduled invocation");
      state.active = undefined;
      const started = await this.options.executor.start(invocation);
      state.active = { ...invocation, executionId: started.executionId };
      await this.options.store.saveState(state);
      return { scheduleId: state.scheduleId, action: "cancelled_previous", invocation };
    }
    const started = await this.options.executor.start(invocation);
    state.active = { ...invocation, executionId: started.executionId };
    await this.options.store.saveState(state);
    return { scheduleId: state.scheduleId, action: actionIfActive, invocation };
  }

  async tick(at = this.now()): Promise<TickResult> {
    const atIso = iso(at);
    const decisions: ScheduleDecision[] = [];
    for (const schedule of await this.options.store.listSchedules()) {
      const state = await this.stateFor(schedule, at);
      if (!schedule.schedule.enabled) {
        await this.options.store.saveState(state);
        decisions.push({ scheduleId: state.scheduleId, action: "disabled" });
        continue;
      }
      const nextDueAt = state.nextDueAt
        ? new Date(state.nextDueAt)
        : nextOccurrence(schedule.schedule, at);
      if (nextDueAt > at) {
        await this.options.store.saveState(state);
        decisions.push({ scheduleId: state.scheduleId, action: "not_due" });
        continue;
      }

      // A tick can span an arbitrary outage. Advance the cursor to the future
      // first, then emit at most one invocation (never a catch-up fan-out).
      const latest = previousOccurrence(schedule.schedule, new Date(at.getTime() + 1));
      state.nextDueAt = iso(nextOccurrence(schedule.schedule, at));
      const scheduledFor = iso(latest);
      const invocation: ScheduleInvocation = {
        scheduleId: state.scheduleId,
        workflowId: schedule.workflowId,
        workflowVersion: schedule.workflowVersion,
        input: inputFor(schedule, "cron"),
        scheduledFor,
        firedAt: atIso,
        idempotencyKey: stableKey(state.scheduleId, scheduledFor, "cron"),
        source: "cron",
      };
      if (schedule.schedule.missed === ("skip" satisfies MissedRunPolicy)) {
        // A due value older than the current polling interval is a missed run.
        // It is still allowed when the tick lands on that exact occurrence.
        const exact = latest.getTime() === at.getTime();
        if (!exact) {
          await this.options.store.saveState(state);
          decisions.push({ scheduleId: state.scheduleId, action: "not_due" });
          continue;
        }
      }
      if (
        !(await this.options.store.claimIdempotencyKey(state.scheduleId, invocation.idempotencyKey))
      ) {
        await this.options.store.saveState(state);
        decisions.push({ scheduleId: state.scheduleId, action: "duplicate", invocation });
        continue;
      }
      decisions.push(await this.startInvocation(schedule, state, invocation));
    }
    return { at: atIso, decisions };
  }

  async fire(
    scheduleId: string,
    override?: JsonObject,
    firedAt = this.now(),
  ): Promise<ScheduleDecision> {
    const schedule = await this.definition(scheduleId);
    if (!manualEnabled(schedule.manual)) return { scheduleId, action: "disabled" };
    const firedAtIso = iso(firedAt);
    const invocation: ScheduleInvocation = {
      scheduleId,
      workflowId: schedule.workflowId,
      workflowVersion: schedule.workflowVersion,
      input: inputFor(schedule, "manual", override),
      scheduledFor: firedAtIso,
      firedAt: firedAtIso,
      idempotencyKey: stableKey(scheduleId, firedAtIso, "manual"),
      source: "manual",
    };
    if (!(await this.options.store.claimIdempotencyKey(scheduleId, invocation.idempotencyKey)))
      return { scheduleId, action: "duplicate", invocation };
    const state = (await this.options.store.getState(scheduleId)) ?? { scheduleId };
    return this.startInvocation(schedule, state, invocation);
  }

  /** Complete the active handoff, starting a queued invocation if one exists. */
  async complete(scheduleId: string, executionId: string): Promise<ScheduleExecution | undefined> {
    const state = await this.options.store.getState(scheduleId);
    if (!state?.active || state.active.executionId !== executionId) return undefined;
    state.active = undefined;
    if (!state.pending) {
      await this.options.store.saveState(state);
      return undefined;
    }
    const pending = state.pending;
    state.pending = undefined;
    const started = await this.options.executor.start(pending);
    state.active = { ...pending, executionId: started.executionId };
    await this.options.store.saveState(state);
    return state.active;
  }
}

export type {
  CronTrigger,
  MissedRunPolicy,
  OverlapPolicy,
  WorkflowTriggers,
} from "@loopy/contracts";
