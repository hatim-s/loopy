import { join } from "node:path";
import { errorMessage, type RunRecord } from "@loopy/core";
import type { Cause } from "effect";
import { Clock, Data, Effect } from "effect";
import { LocalExecutor } from "../../executor";
import { makeDaemon, PreparationError, ScheduleDefinitionError } from "../../host";
import { tryPidLock } from "../../os";
import { requireDefinition } from "../../service";
import type { SqlRunStore } from "../../store";
import { Registry } from "../registry";
import { startServer } from "../server/start-server";
import { makeLocalService } from "../service";
import { removeDaemonFile, writeDaemonFile } from "./file";

export class LocalDaemonError extends Data.TaggedError("LocalDaemonError")<{
  operation: "start" | "stop";
  cause: unknown;
  reason: "failed" | "timeout";
}> {
  override get message() {
    return this.operation === "start"
      ? `Cannot start daemon: ${errorMessage(this.cause)}`
      : this.reason === "timeout"
        ? "Daemon shutdown timed out. Discovery was kept. Check the process before restarting."
        : `Daemon shutdown failed: ${errorMessage(this.cause)} Discovery was kept. Check the process before restarting.`;
  }
}

type DaemonOptions = {
  home: string;
  cwd: string;
  store: SqlRunStore;
  concurrency: number;
  port: number;
  assets: string;
  onError?: (cause: Cause.Cause<unknown>, run?: RunRecord) => void;
};

/** The caller's scope must outlive requests and close before the store scope. */
export const localDaemon = (options: DaemonOptions) =>
  Effect.gen(function* () {
    const daemon = yield* makeDaemon({
      store: options.store,
      concurrency: options.concurrency,
      onError: options.onError,
      definitionFor: (schedule) =>
        Registry.make(options.home, schedule.workspace).pipe(
          Effect.flatMap((registry) => requireDefinition(registry, schedule.slug)),
          Effect.mapError((cause) => new ScheduleDefinitionError({ cause })),
        ),
      prepare: (run) =>
        Effect.gen(function* () {
          const registry = yield* Registry.make(options.home, run.workspace);
          const graph = yield* registry.revisionGraph(run.revision);

          return {
            graph,
            executor: new LocalExecutor({
              home: options.home,
              workspace: run.workspace,
              mode: graph.meta.mode,
              secrets: graph.meta.secrets,
              bundlePath: (hash) => registry.bundlePath(hash),
            }),
          };
        }).pipe(Effect.mapError((cause) => new PreparationError({ cause }))),
    });

    const service = makeLocalService({
      home: options.home,
      store: options.store,
      clock: { now: Date.now },
    });

    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const token = crypto.randomUUID();
    let server: ReturnType<typeof startServer> | undefined;
    let releaseLock: (() => void) | undefined;
    let stopped = false;

    const start = Effect.suspend(() => {
      if (server && !stopped) {
        return Effect.succeed(server.url);
      }

      let created = false;

      return Effect.try({
        try: () => {
          if (stopped) {
            throw new Error("This daemon has stopped. Create a new daemon scope.");
          }

          // The lock outlives a crashed owner, so a dead daemon never blocks the next one.
          const lock = tryPidLock(join(options.home, "daemon.lock"));

          if (lock.kind === "held") {
            throw new Error(
              `A daemon is already running for this home (PID ${lock.pid}). Use loopy ui to open it.`,
            );
          }

          if (lock.kind === "starting") {
            throw new Error("Another daemon is starting for this home. Use loopy ui to open it.");
          }

          releaseLock = lock.release;
          // Discovery is published after the listener binds, so it always names a live port.
          server = startServer({
            ...options,
            service,
            token,
            daemon: { pid: process.pid, startedAt, concurrency: options.concurrency },
          });
          created = true;
          writeDaemonFile(options.home, { pid: process.pid, port: server.port, token, startedAt });

          return server.url;
        },
        catch: (cause) => new LocalDaemonError({ operation: "start", reason: "failed", cause }),
      }).pipe(
        Effect.catchTag("LocalDaemonError", (error) => {
          if (!created) {
            return Effect.andThen(Effect.orDie(unlock), Effect.fail(error));
          }

          stopped = true;

          return Effect.acquireUseRelease(
            Effect.void,
            () => Effect.fail(error),
            () => Effect.andThen(closeListener, unlock).pipe(Effect.orDie),
          );
        }),
      );
    });

    const closeListener = Effect.gen(function* () {
      const active = server;

      if (active) {
        yield* Effect.tryPromise({
          try: () => active.stop(),
          catch: (cause) => new LocalDaemonError({ operation: "stop", reason: "failed", cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: 5000,
            orElse: () =>
              Effect.fail(
                new LocalDaemonError({ operation: "stop", reason: "timeout", cause: undefined }),
              ),
          }),
        );
      }
    });

    const removeDiscovery = Effect.try({
      try: () => removeDaemonFile(options.home, token),
      catch: (cause) => new LocalDaemonError({ operation: "stop", reason: "failed", cause }),
    });

    const unlock = Effect.try({
      try: () => {
        const release = releaseLock;
        releaseLock = undefined;
        release?.();
      },
      catch: (cause) => new LocalDaemonError({ operation: "stop", reason: "failed", cause }),
    });

    const stop = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.gen(function* () {
          stopped = true;
          // Stop accepting requests before joining workers and releasing the database.
          yield* Effect.acquireUseRelease(
            Effect.void,
            () => closeListener,
            () => daemon.stop,
          );
          yield* removeDiscovery;
          yield* unlock;
        }),
      ),
    );

    yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie));

    return {
      startedAt,
      concurrency: options.concurrency,
      start,
      stop,
      wake: daemon.wake,
      run: Effect.andThen(start, daemon.run),
    };
  });
