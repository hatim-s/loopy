import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Route, RouteInput, RouteResult } from "@loopy/contract";
import { readDaemonFile } from "@loopy/runtime/local";
import { daemonCommand } from "../../../../packages/cli/src/entry";
import { ApiClient } from "../shared/api-client";
import { JourneyFailure } from "../shared/assert";
import { requireFreePorts } from "../stack/ports";
import { environment, home, port, source, state } from "./config";
import { DAEMON } from "./plan";
import { runtimeSource } from "./source";

export class OwnedDaemon {
  private child?: ReturnType<typeof Bun.spawn>;
  private log?: Awaited<ReturnType<typeof open>>;
  readonly starts: {
    pid: number;
    startedAt: string;
    beforeSpawn: Awaited<ReturnType<typeof runtimeSource>>;
    afterReady: Awaited<ReturnType<typeof runtimeSource>>;
  }[] = [];

  async start() {
    if (this.child) {
      throw new Error("This runner already owns a daemon process.");
    }

    await requireFreePorts([port]);

    if (readDaemonFile(home)) {
      throw new Error("The isolated home already has a live daemon. Refusing to adopt it.");
    }

    await mkdir(home, { recursive: true });
    this.log = await open(resolve(state, "daemon.log"), "a", 0o600);
    const beforeSpawn = await runtimeSource();
    this.child = Bun.spawn(this.command(), {
      cwd: source,
      env: environment(),
      stdin: "ignore",
      stdout: this.log.fd,
      stderr: this.log.fd,
    });
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(
          `Owned daemon exited with ${this.child.exitCode}. Inspect its isolated log.`,
        );
      }

      const record = readDaemonFile(home);

      if (record?.pid === this.child.pid && record.port === port) {
        this.starts.push({
          pid: record.pid,
          startedAt: record.startedAt,
          beforeSpawn,
          afterReady: await runtimeSource(),
        });

        return;
      }

      await Bun.sleep(50);
    }

    throw new Error("Owned daemon did not become ready within ten seconds.");
  }

  private command() {
    const [bun, ...rest] = daemonCommand({
      home,
      cwd: source,
      port,
      concurrency: DAEMON.concurrency,
      leaseMs: DAEMON.leaseMs,
    });

    // The playground daemon must not pick up a repository .env file.
    return [bun, "--no-env-file", ...rest];
  }

  async singletonProbe() {
    const child = Bun.spawn(this.command(), {
      cwd: source,
      env: environment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const result = await Promise.race([
      Promise.all([child.exited, new Response(child.stderr).text()]),
      Bun.sleep(5000).then(() => null),
    ]);

    if (!result) {
      child.kill("SIGTERM");
      await child.exited;
      throw new Error("Competing daemon failed to reject within five seconds.");
    }

    const [exitCode, stderr] = result;

    return { exitCode, rejected: exitCode !== 0, reason: stderr.trim() };
  }

  // Each request re-reads discovery, so a replaced daemon never receives this runner's calls.
  private readonly client = new ApiClient({
    origin: `http://127.0.0.1:${port}`,
    token: null,
    timeoutMs: 10_000,
    transport: (url, init) => {
      const record = readDaemonFile(home);

      if (!this.child || record?.pid !== this.child.pid || record.port !== port) {
        throw new JourneyFailure({ failure: "daemon_discovery_not_owned" });
      }

      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${record.token}`);

      return fetch(url, { ...init, headers });
    },
  });

  call<R extends Route>(route: R, input: RouteInput<R>): Promise<RouteResult<R>> {
    return this.client.call(route, input);
  }

  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    const child = this.child;

    if (!child) {
      return;
    }

    child.kill(signal);

    const ended = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);

    if (!ended) {
      child.kill("SIGKILL");
      await child.exited;
    }

    this.child = undefined;
    await this.log?.close();
    this.log = undefined;
  }
}
