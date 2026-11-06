import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Semaphore } from "effect";
import type { AttemptBackend } from "../../../sandbox/src/docker";
import { failure, io } from "../../../sandbox/src/operations";
import { state } from "./config";

export class RuntimeLimit {
  private readonly semaphore;

  constructor(capacity: number) {
    this.semaphore = Semaphore.makeUnsafe(capacity);
  }

  run<A, E, R>(operation: Effect.Effect<A, E, R>, signal?: AbortSignal) {
    const guarded = this.semaphore.withPermit(operation);

    if (!signal) {
      return guarded;
    }

    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        yield* Effect.raceFirst(
          this.semaphore.takeScoped(1),
          Effect.callback<never, ReturnType<typeof failure>>((resume) => {
            const abort = () =>
              resume(Effect.fail(failure("runtime queue aborted", signal.reason)));

            signal.addEventListener("abort", abort, { once: true });

            if (signal.aborted) {
              abort();
            }

            return Effect.sync(() => signal.removeEventListener("abort", abort));
          }),
        );

        if (signal.aborted) {
          return yield* Effect.fail(failure("runtime queue aborted", signal.reason));
        }

        return yield* operation;
      }),
    );
  }
}

export function boundedBackend(backend: AttemptBackend, capacity: number): AttemptBackend {
  const limit = new RuntimeLimit(capacity);

  return {
    start: (receipt, request, signal) =>
      Effect.suspend(() => {
        const queuedAt = Date.now();

        return limit.run(
          Effect.gen(function* () {
            const acquiredAt = Date.now();
            let outcome = "expired-in-queue";

            return yield* Effect.gen(function* () {
              if (Date.now() >= receipt.deadline) {
                return {
                  kind: "failed" as const,
                  error: {
                    code: "execution" as const,
                    message: "Attempt deadline elapsed in playground backend queue.",
                  },
                  exitCode: null,
                  logs: [],
                };
              }

              const result = yield* backend.start(receipt, request, signal).pipe(
                Effect.onError(() => {
                  outcome = "transport-exception";

                  return io("abort marker", () =>
                    writeFile(
                      resolve(state, "ABORT"),
                      "Docker backend threw. Stop new admissions and reconcile owned containers.\n",
                    ),
                  ).pipe(Effect.orDie);
                }),
              );

              outcome = result.kind === "failed" ? result.error.code : "succeeded";

              if (result.kind === "failed" && result.error.code === "uncertain") {
                yield* io("abort marker", () =>
                  writeFile(
                    resolve(state, "ABORT"),
                    "Provider returned an uncertain execution. Reconcile containers and receipts before resuming.\n",
                  ),
                );
              }

              return result;
            }).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  const finishedAt = Date.now();

                  return io("queue evidence", () =>
                    appendFile(
                      resolve(state, "runtime-queue.jsonl"),
                      `${JSON.stringify({ executionKey: receipt.executionKey, attempt: receipt.attempt, queuedAt: new Date(queuedAt).toISOString(), acquiredAt: new Date(acquiredAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(), queueWaitMs: acquiredAt - queuedAt, backendDurationMs: finishedAt - acquiredAt, outcome })}\n`,
                      { mode: 0o600 },
                    ),
                  ).pipe(Effect.orDie);
                }),
              ),
            );
          }),
          signal,
        );
      }),
    recover: (receipt, signal) => limit.run(backend.recover(receipt, signal), signal),
  };
}
