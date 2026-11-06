import { mkdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { Schema } from "effect";
import type { routes } from "../../packages/loopy/src/contract";
import { decodeBoundary } from "../../packages/loopy/src/contract";

type Mutation =
  | Schema.Schema.Type<typeof routes.startRun.body>
  | Schema.Schema.Type<typeof routes.resolveNamedHook.body>;

import { errorBodySchema } from "../../packages/loopy/src/contract";
import { readDaemonFile } from "../../packages/loopy/src/local";
import { cli, environment, home, port, source, state } from "./config";
import { runtimeSource } from "./source";

export async function requireFreePort() {
  const probe = createServer();
  await new Promise<void>((accept, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", accept);
  });
  await new Promise<void>((accept, reject) =>
    probe.close((error) => (error ? reject(error) : accept())),
  );
}

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

    await requireFreePort();

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
    return [
      process.execPath,
      "--no-env-file",
      cli,
      "--home",
      home,
      "--cwd",
      source,
      "--lease-ms",
      "2000",
      "daemon",
      "run",
      "--port",
      String(port),
      "--concurrency",
      "4",
    ];
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

  async request<T>(path: string, schema: Schema.Codec<T, unknown, never, never>, body?: Mutation) {
    const record = readDaemonFile(home);

    if (!this.child || record?.pid !== this.child.pid || record.port !== port) {
      throw new Error("Daemon discovery does not match the process this runner owns.");
    }

    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    const value: unknown = await response.json();

    if (!response.ok) {
      throw new Error(`${response.status}: ${decodeBoundary(errorBodySchema)(value).error.code}`);
    }

    return decodeBoundary(schema)(value);
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
