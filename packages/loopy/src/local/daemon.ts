import type { RunRecord } from "../core/index.js";
import { LocalExecutor } from "../executor/index.js";
import { Daemon, SYSTEM_CLOCK } from "../host/index.js";
import type { SqliteRunStore } from "../store/index.js";
import { readDaemonFile, removeDaemonFile, writeDaemonFile } from "./daemon-file.js";
import { withLockDirectory } from "./fs.js";
import { homePaths } from "./home.js";
import { Registry } from "./registry.js";
import { SecretStore } from "./secrets.js";
import { startServer } from "./server/start-server.js";
import { requireLoopy } from "./service/context.js";
import { LoopyService } from "./service/index.js";

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
    revisionFor: (schedule) =>
      requireLoopy(new Registry(home, schedule.workspace), schedule.slug).revision,
    prepare: async (run) => {
      const registry = new Registry(home, run.projectRoot);

      const graph = await registry.readGraph(run.revision);

      return {
        graph,
        executor: new LocalExecutor({
          home,
          workspace: run.runDirectory,
          mode: graph.meta.mode,
          secrets: Object.fromEntries(
            graph.meta.secrets.map((name) => [name, new SecretStore(home).get(name)]),
          ),
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
  private starting?: Promise<string>;
  private stopping?: Promise<void>;

  constructor(private readonly options: DaemonOptions) {
    this.daemon = runtimeDaemon(options);
    this.service = new LoopyService({
      store: options.store,
      home: options.home,
      registry: (workspace) => new Registry(options.home, workspace),
      clock: SYSTEM_CLOCK,
    });
    this.concurrency = options.concurrency;
  }

  wake() {
    this.daemon.wake();
  }

  async start(): Promise<string> {
    if (this.server) {
      return this.server.url;
    }

    if (this.stopping) {
      throw new Error("The daemon is stopping.");
    }

    this.starting ??= withLockDirectory(
      homePaths(this.options.home).startLock,
      "daemon startup",
      () => this.startLocked(),
    ).catch((error) => {
      this.starting = undefined;
      throw error;
    });

    return this.starting;
  }

  private async startLocked(): Promise<string> {
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
      await writeDaemonFile(home, {
        pid: process.pid,
        port: server.port,
        token: this.token,
        startedAt: this.startedAt,
      });
    } catch (error) {
      await server.stop();
      throw error;
    }

    this.server = server;

    return server.url;
  }

  async run(): Promise<void> {
    await this.start();

    return this.daemon.run();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      try {
        await this.starting;
      } finally {
        await this.server?.stop();
        await this.daemon.stop();
        removeDaemonFile(this.options.home, this.token);
      }
    })();

    return this.stopping;
  }
}

export function localDaemon(options: DaemonOptions) {
  return new LocalDaemon(options);
}
