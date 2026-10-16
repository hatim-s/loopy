import type { EngineLog, LogLevel } from "../core/index.js";
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
    info: (message: string, data?: EngineLog["data"]) => this.write("info", message, data),
    warn: (message: string, data?: EngineLog["data"]) => this.write("warn", message, data),
    error: (message: string, data?: EngineLog["data"]) => this.write("error", message, data),
  };

  constructor(
    private readonly options: {
      runId: string;
      token: string;
      store: RunStore;
      logs: EngineLog[];
      journal: StepJournal;
      activation: Activation;
      clock: Clock;
    },
  ) {
    this.seq = Math.max(0, ...options.logs.map((log) => log.seq));
    this.positions = new Set(options.logs.map((log) => JSON.stringify(log.position)));
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private write(level: LogLevel, message: string, data?: EngineLog["data"]): void {
    const { journal, activation, clock, runId, store, token } = this.options;
    const state = `${journal.seq}:${activation.finished}`;
    const index = (this.indexes.get(state) ?? 0) + 1;
    this.indexes.set(state, index);
    const position = { afterStep: journal.seq, afterFinish: activation.finished, index };
    const identity = JSON.stringify(position);

    if (this.positions.has(identity)) {
      return;
    }

    this.positions.add(identity);

    const log: EngineLog = {
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
