import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeBoundary, routes } from "@loopy/contract";
import { readDaemonFile } from "@loopy/runtime/local";
import { Data, Effect } from "effect";

const cliPath = resolve(import.meta.dir, "../../../cli/src/index.ts");

export class AcceptanceError extends Data.TaggedError("AcceptanceError")<{
  operation: string;
  cause: unknown;
}> {}

export const io = <A>(operation: string, body: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => new AcceptanceError({ operation, cause }) });

export const verify = (body: () => void) =>
  Effect.try({ try: body, catch: (cause) => new AcceptanceError({ operation: "verify", cause }) });

export class Runtime {
  private child?: ReturnType<typeof Bun.spawn>;
  private log?: Awaited<ReturnType<typeof open>>;
  private ordinal = 0;
  readonly starts: number[] = [];
  readonly home: string;
  readonly env;

  constructor(
    readonly root: string,
    readonly workspace: string,
  ) {
    this.home = join(root, "home");
    this.env = {
      HOME: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LOOPY_HOME: this.home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
    };
  }

  cli(...args: string[]) {
    return Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            cliPath,
            "--home",
            this.home,
            "--cwd",
            this.workspace,
            ...args,
          ],
          { cwd: this.workspace, env: this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ),
      ),
      (child) =>
        io(`CLI ${args[0]}`, async (signal) => {
          const abort = () => child.kill("SIGKILL");
          signal.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(abort, 20_000);

          try {
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);

            await Bun.write(
              join(this.root, `cli-${++this.ordinal}.json`),
              JSON.stringify({ args, stdout, stderr, exitCode }, null, 2),
            );

            if (exitCode !== 0) {
              throw new Error(`CLI ${args[0]} exited ${exitCode}: ${stderr}`);
            }

            return stdout;
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          }
        }),
      (child) =>
        io("release CLI", async () => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }

          await child.exited;
        }),
    );
  }

  start() {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.uninterruptible(
        io("start daemon", async () => {
          if (this.child || readDaemonFile(this.home)) {
            throw new Error("Refusing to adopt an existing daemon.");
          }

          this.log = await open(join(this.root, "daemon.log"), "a", 0o600);
          this.child = Bun.spawn(
            [
              process.execPath,
              "--no-env-file",
              cliPath,
              "--home",
              this.home,
              "--cwd",
              this.workspace,
              "--lease-ms",
              "2000",
              "daemon",
              "run",
              "--port",
              "0",
              "--concurrency",
              "4",
            ],
            {
              cwd: this.workspace,
              env: this.env,
              stdin: "ignore",
              stdout: this.log.fd,
              stderr: this.log.fd,
            },
          );
          this.starts.push(this.child.pid);
        }),
      );
      yield* this.until(
        Effect.sync(() => {
          if (this.child?.exitCode !== null) {
            throw new Error("Daemon exited before readiness. Inspect daemon.log.");
          }

          return readDaemonFile(this.home)?.pid === this.child.pid;
        }),
      );
    });
  }

  response(path: string) {
    return io(`GET ${path}`, async (signal) => {
      const record = readDaemonFile(this.home);

      if (!record || record.pid !== this.child?.pid) {
        throw new Error("Daemon ownership mismatch.");
      }

      const response = await fetch(`http://127.0.0.1:${record.port}/api${path}`, {
        headers: { Authorization: `Bearer ${record.token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });

      if (!response.ok) {
        throw new Error(`Snapshot HTTP ${response.status}`);
      }

      const value: unknown = await response.json();

      return value;
    });
  }

  snapshot(id: string) {
    return this.response(`/runs/${encodeURIComponent(id)}`).pipe(
      Effect.map(decodeBoundary(routes.run.response)),
    );
  }

  graph(id: string) {
    return this.response(`/runs/${encodeURIComponent(id)}/graph`).pipe(
      Effect.map(decodeBoundary(routes.runGraph.response)),
    );
  }

  revision(id: string) {
    return this.response(`/runs/${encodeURIComponent(id)}/graph`).pipe(
      Effect.map((value) => decodeBoundary(routes.runGraph.response)(value).revision),
    );
  }

  until<E>(predicate: Effect.Effect<boolean, E>, timeout = 30_000) {
    return Effect.gen(function* () {
      const deadline = Date.now() + timeout;

      while (Date.now() < deadline) {
        if (yield* predicate) {
          return;
        }

        yield* Effect.sleep("100 millis");
      }

      return yield* Effect.fail(
        new AcceptanceError({ operation: "deadline", cause: `${timeout}ms exceeded` }),
      );
    });
  }

  stop() {
    return Effect.uninterruptible(
      io("stop daemon", async () => {
        const child = this.child;

        if (!child) {
          await this.log?.close();
          this.log = undefined;

          return;
        }

        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);

        try {
          await child.exited;
        } finally {
          clearTimeout(timer);
          this.child = undefined;
          await this.log?.close();
          this.log = undefined;
        }
      }),
    );
  }
}
