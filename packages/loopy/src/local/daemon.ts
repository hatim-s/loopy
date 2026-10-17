import type { RunRecord } from "../core/index.js";
import { Daemon, SYSTEM_CLOCK } from "../runtime/index.js";
import { loopyActivation } from "../sdk/host.js";
import { loadRunLoopy } from "./bundle.js";
import { readRateLimits } from "./config.js";
import { readDaemonFile, removeDaemonFile, writeDaemonFile } from "./daemon-file.js";
import { LocalExecutor } from "./executor.js";
import { Registry } from "./registry.js";
import { startServer } from "./server/start-server.js";
import { LoopyService } from "./service.js";
import type { SqliteRunStore } from "./store.js";

type DaemonOptions = {
  home: string;
  cwd: string;
  store: SqliteRunStore;
  concurrency?: number;
  port?: number;
  assets?: string;
  onError?: (error: Error, run?: RunRecord) => void;
};

function runtimeDaemon(options: DaemonOptions) {
  const { home } = options;
  const rateLimits = readRateLimits(home);

  return new Daemon({
    ...options,
    bundleHashFor: (schedule) =>
      new Registry(home, schedule.workspace).get(schedule.slug).bundleHash,
    prepare: async (run) => {
      const loopy = await loadRunLoopy(home, run);

      return {
        ...loopyActivation(loopy),
        rateLimits,
        executor: new LocalExecutor({ home, secrets: loopy.secrets }),
        mode: loopy.mode,
        cwd: run.workspace,
      };
    },
  });
}

class LocalDaemon {
  private readonly daemon: Daemon;
  private readonly service: LoopyService;
  private readonly token = crypto.randomUUID();
  private server?: ReturnType<typeof startServer>;
  private retention?: ReturnType<typeof setInterval>;
  private stopping?: Promise<void>;

  constructor(private readonly options: DaemonOptions) {
    this.daemon = runtimeDaemon(options);
    this.service = new LoopyService({
      home: options.home,
      store: options.store,
      registry: (workspace) => new Registry(options.home, workspace || options.cwd),
      clock: SYSTEM_CLOCK,
    });
    this.service.concurrency = options.concurrency ?? 4;
  }

  tick() {
    return this.daemon.tick();
  }
  wake() {
    this.daemon.wake();
  }

  start(): string {
    if (this.server) {
      return this.server.url;
    }

    const { home, store, cwd, port, assets } = this.options;

    if (readDaemonFile(home)) {
      throw new Error("A daemon is already running for this home. Use loopy ui to open it.");
    }

    const server = startServer({
      service: this.service,
      store,
      token: this.token,
      cwd,
      port,
      assets,
    });

    try {
      writeDaemonFile(home, {
        pid: process.pid,
        port: server.port,
        token: this.token,
        startedAt: this.service.startedAt,
      });
    } catch (error) {
      void server.stop();
      throw error;
    }

    this.server = server;
    this.prune();
    this.retention = setInterval(() => this.prune(), 3_600_000);

    return server.url;
  }

  run(): Promise<void> {
    this.start();

    return this.daemon.run();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      clearInterval(this.retention);
      await this.server?.stop();
      await this.daemon.stop();
      removeDaemonFile(this.options.home, this.token);
    })();

    return this.stopping;
  }

  private prune(): void {
    void this.options.store
      .pruneEvents(new Date().toISOString())
      .catch((error: Error) => this.options.onError?.(error));
  }
}

export function localDaemon(options: DaemonOptions) {
  return new LocalDaemon(options);
}
