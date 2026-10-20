import { join } from "node:path";
import type { RunRecord } from "../core/index.js";
import { LocalExecutor } from "../executor/index.js";
import { Daemon, SYSTEM_CLOCK } from "../host/index.js";
import type { SqliteRunStore } from "../store/index.js";
import { readDaemonFile, removeDaemonFile, writeDaemonFile } from "./daemon-file.js";
import { withLockDirectory } from "./fs.js";
import { Registry } from "./registry.js";
import { startServer } from "./server/start-server.js";
import { LoopyService } from "./service.js";

type DaemonOptions = {
  home: string;
  cwd: string;
  store: SqliteRunStore;
  concurrency: number;
  port?: number;
  assets?: string;
  onError?: (error: Error, run?: RunRecord) => void;
};

function runtimeDaemon(options: DaemonOptions) {
  const { home, store, concurrency, onError } = options;

  return new Daemon({
    store,
    concurrency,
    onError,
    revisionFor: (schedule) => new Registry(home, schedule.workspace).get(schedule.slug).revision,
    prepare: async (run) => {
      const registry = new Registry(home, run.workspace);

      const graph = await registry.revisionGraph(run.revision);

      return {
        graph,
        executor: new LocalExecutor({
          home,
          workspace: run.workspace,
          mode: graph.meta.mode,
          secrets: graph.meta.secrets,
          bundlePath: (hash) => registry.bundlePath(hash),
        }),
      };
    },
  });
}

class LocalDaemon {
  readonly startedAt = new Date(SYSTEM_CLOCK.now()).toISOString();
  readonly concurrency: number;
  private readonly daemon: Daemon;
  private readonly service: LoopyService;
  private readonly token = crypto.randomUUID();
  private server?: ReturnType<typeof startServer>;
  private stopping?: Promise<void>;

  constructor(private readonly options: DaemonOptions) {
    this.daemon = runtimeDaemon(options);
    this.service = new LoopyService({
      store: options.store,
      registry: (workspace) => new Registry(options.home, workspace || options.cwd),
      clock: SYSTEM_CLOCK,
    });
    this.concurrency = options.concurrency;
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

    return withLockDirectory(join(this.options.home, "daemon-start.lock"), "daemon startup", () =>
      this.startLocked(),
    );
  }

  private startLocked(): string {
    if (this.server) {
      return this.server.url;
    }

    const { home, store, cwd, port, assets } = this.options;

    if (readDaemonFile(home)) {
      throw new Error("A daemon is already running for this home. Use loopy ui to open it.");
    }

    const server = startServer({
      service: this.service,
      daemon: this,
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
        startedAt: this.startedAt,
      });
    } catch (error) {
      void server.stop();
      throw error;
    }

    this.server = server;

    return server.url;
  }

  run(): Promise<void> {
    this.start();

    return this.daemon.run();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      await this.server?.stop();
      await this.daemon.stop();
      removeDaemonFile(this.options.home, this.token);
    })();

    return this.stopping;
  }
}

export function localDaemon(options: DaemonOptions) {
  return new LocalDaemon(options);
}
