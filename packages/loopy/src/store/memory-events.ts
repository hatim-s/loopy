import type {
  LogRecord,
  RunRecord,
  RuntimeEvent,
  RuntimeEventChange,
  Schedule,
} from "../core/index.js";
import { type NodeRun, type RateLimitWindow, type WaitRecord } from "../core/index.js";
import { EVENT_RETENTION, EventListeners, type EventTransaction } from "./event-outbox.js";

export class MemoryEvents {
  protected limits = new Map<string, RateLimitWindow>();

  protected schedules = new Map<string, Schedule>();

  protected runs = new Map<string, RunRecord>();

  protected nodes = new Map<string, Map<string, NodeRun>>();

  protected waits = new Map<string, WaitRecord>();

  protected attempts = new Map<string, Map<number, NodeRun>>();

  protected logNodeIds = new Map<number, string>();

  protected logIds = new Map<number, LogRecord>();

  protected logSequence = 0;

  protected logUsage = new Map<string, { bytes: number; index: number }>();

  protected logs = new Map<string, Map<number, LogRecord>>();

  constructor(
    protected readonly now: () => number = Date.now,
    readonly leaseMs = 60_000,
  ) {}

  protected eventLog: RuntimeEvent[] = [];

  protected sequence = 0;

  protected readonly storeEpoch = crypto.randomUUID();

  protected readonly listeners = new EventListeners();

  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    return this.listeners.subscribe(listener);
  }

  oldestEventSequence(): number | undefined {
    return this.eventLog[0]?.sequence ?? (this.sequence === 0 ? undefined : this.sequence + 1);
  }

  async events(after: number, limit: number): Promise<RuntimeEvent[]> {
    return structuredClone(this.eventLog.filter((event) => event.sequence > after).slice(0, limit));
  }

  async epoch(): Promise<string> {
    return this.storeEpoch;
  }

  async eventCursor(): Promise<{ cursor: number; epoch: string }> {
    return { cursor: this.sequence, epoch: this.storeEpoch };
  }

  async pruneEvents(now: string): Promise<number> {
    const cutoff = Date.parse(now) - EVENT_RETENTION.maxAgeMs;

    const kept = this.eventLog
      .slice(-EVENT_RETENTION.maxRows)
      .filter((event) => Date.parse(event.at) >= cutoff);

    const deleted = this.eventLog.length - kept.length;
    this.eventLog = kept;

    return deleted;
  }

  protected commit<T>(change: (txn: EventTransaction) => T): T {
    const txn: EventTransaction = { id: crypto.randomUUID(), events: [] };

    const backup = structuredClone({
      runs: this.runs,
      nodes: this.nodes,
      waits: this.waits,
      logs: this.logs,
      attempts: this.attempts,
      logUsage: this.logUsage,
      logIds: this.logIds,
      logNodeIds: this.logNodeIds,
      logSequence: this.logSequence,
      schedules: this.schedules,
      limits: this.limits,
      sequence: this.sequence,
    });

    let result: T;

    try {
      result = change(txn);
    } catch (cause) {
      this.runs = backup.runs;
      this.nodes = backup.nodes;
      this.waits = backup.waits;
      this.logs = backup.logs;
      this.attempts = backup.attempts;
      this.logUsage = backup.logUsage;
      this.logIds = backup.logIds;
      this.logNodeIds = backup.logNodeIds;
      this.logSequence = backup.logSequence;
      this.schedules = backup.schedules;
      this.limits = backup.limits;
      this.sequence = backup.sequence;
      throw cause;
    }

    this.eventLog.push(...txn.events);

    this.listeners.publish(txn.events);

    return result;
  }

  protected emit(txn: EventTransaction, change: RuntimeEventChange): void {
    txn.events.push(
      structuredClone({ ...change, sequence: ++this.sequence, at: this.timestamp(), txn: txn.id }),
    );
  }

  protected timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}
