import type {
  LogRecord,
  RunRecord,
  RuntimeEvent,
  RuntimeEventChange,
  Schedule,
} from "../core/index.js";
import { type NodeRun, type RateLimitWindow, type WaitRecord } from "../core/index.js";
import { EVENT_RETENTION, EventListeners, type EventTransaction } from "./event-outbox.js";
import { storageOperation } from "./operation.js";
import { utc } from "./timestamps.js";

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

  oldestEventSequence() {
    return storageOperation("oldestEventSequence", () => {
      return this.eventLog[0]?.sequence ?? (this.sequence === 0 ? undefined : this.sequence + 1);
    });
  }

  events(after: number, limit: number) {
    return storageOperation("events", () => {
      return structuredClone(
        this.eventLog.filter((event) => event.sequence > after).slice(0, limit),
      );
    });
  }

  transactionEvents(txn: string, after: number) {
    return storageOperation("transactionEvents", () =>
      structuredClone(this.eventLog.filter((event) => event.txn === txn && event.sequence > after)),
    );
  }

  epoch() {
    return storageOperation("epoch", () => {
      return this.storeEpoch;
    });
  }

  eventCursor() {
    return storageOperation("eventCursor", () => {
      return { cursor: this.sequence, epoch: this.storeEpoch };
    });
  }

  pruneEvents(now: string) {
    return storageOperation("pruneEvents", () => {
      const cutoff = Date.parse(now) - EVENT_RETENTION.maxAgeMs;

      let boundary = Math.max(-1, this.eventLog.length - EVENT_RETENTION.maxRows - 1);

      for (let index = 0; index < this.eventLog.length; index++) {
        const event = this.eventLog[index];

        if (event && Date.parse(event.at) < cutoff) {
          boundary = Math.max(boundary, index);
        }
      }

      const transaction = this.eventLog[boundary]?.txn;

      while (transaction !== undefined && this.eventLog[boundary + 1]?.txn === transaction) {
        boundary++;
      }

      const deleted = boundary + 1;
      this.eventLog = this.eventLog.slice(deleted);

      return deleted;
    });
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
    return utc(this.now());
  }
}
