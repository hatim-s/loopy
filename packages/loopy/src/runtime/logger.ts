import type { LogLevel, LogPosition, LogRecord } from "../core/index.js";
import type { Activation } from "./activation.js";
import type { Clock } from "./clock.js";
import type { StepJournal } from "./journal.js";
import type { RunStore } from "./store.js";

export class Logger {
  private seq: number;
  private readonly positions: Set<string>;
  private readonly indexes = new Map<string, number>();
  private writes = Promise.resolve();
  readonly log = {
    info: (message: string, data?: LogRecord["data"]) => this.write("info", message, data),
    warn: (message: string, data?: LogRecord["data"]) => this.write("warn", message, data),
    error: (message: string, data?: LogRecord["data"]) => this.write("error", message, data),
  };

  constructor(
    private readonly options: {
      runId: string;
      token: string;
      store: RunStore;
      logs: LogRecord[];
      journal: StepJournal;
      activation: Activation;
      clock: Clock;
    },
  ) {
    this.seq = Math.max(0, ...options.logs.map((log) => log.seq));
    this.positions = new Set(
      options.logs
        .filter((log) => log.position.kind === "workflow")
        .map((log) => JSON.stringify(log.position)),
    );
  }

  flush(): Promise<void> {
    return this.writes;
  }

  scope(seq: number, attempt: number) {
    let index = 0;

    const write = (level: LogLevel, message: string, data?: LogRecord["data"]) =>
      this.append({ kind: "step", seq, attempt, index: ++index }, level, message, data);

    return {
      info: (message: string, data?: LogRecord["data"]) => write("info", message, data),
      warn: (message: string, data?: LogRecord["data"]) => write("warn", message, data),
      error: (message: string, data?: LogRecord["data"]) => write("error", message, data),
    };
  }

  private write(level: LogLevel, message: string, data?: LogRecord["data"]): void {
    const { journal, activation } = this.options;
    const state = `${journal.seq}:${activation.finished}`;
    const index = (this.indexes.get(state) ?? 0) + 1;
    this.indexes.set(state, index);

    const position = {
      kind: "workflow",
      afterStep: journal.seq,
      afterFinish: activation.finished,
      index,
    } as const;

    const identity = JSON.stringify(position);

    if (this.positions.has(identity)) {
      return;
    }

    this.positions.add(identity);
    this.append(position, level, message, data);
  }

  private append(
    position: LogPosition,
    level: LogLevel,
    message: string,
    data?: LogRecord["data"],
  ): void {
    const { clock, runId, store, token } = this.options;

    const log: LogRecord = {
      runId,
      seq: ++this.seq,
      position,
      level,
      message,
      at: new Date(clock.now()).toISOString(),
    };

    if (data !== undefined) {
      log.data = data;
    }

    this.writes = this.writes.then(() => store.appendLog(runId, token, log));
    // The engine observes failures after the workflow settles, even when callers do not await logs.
    void this.writes.catch(() => {});
  }
}
