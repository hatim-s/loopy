import { expect, test } from "bun:test";
import { type Executor, OwnershipError, StorageError } from "@loopy/core";
import {
  ActivationWorkCleanupFailed,
  activate,
  DriverCleanupFailed,
  LeaseReleaseFailed,
} from "@loopy/runtime/host";
import { code, loopy, parallel } from "@loopy/sdk/graph";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "./fixture";
import { MemorySqlStore } from "./store-fixture";

function graph(wide = false) {
  const work = () =>
    code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" });

  const graph = loopy("test", {
    input: {},
    run: () => (wide ? parallel({ first: work, second: work }) : work()),
  });

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}

const unavailable = (operation: string) =>
  new StorageError({ operation, reason: "unavailable", cause: new Error(operation) });

for (const primary of ["read", "graph", "interrupt"] as const) {
  test(`release failure preserves full ${primary} exit`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();

        class BrokenStore extends MemorySqlStore {
          override getNodeRuns(id: string) {
            return primary === "read" ? Effect.fail(unavailable("read")) : super.getNodeRuns(id);
          }
          override release() {
            return Effect.fail(unavailable("release"));
          }
        }

        const store = new BrokenStore();
        yield* store.createRun(newRun());

        const executor: Executor = {
          lookup: () => Effect.succeed({ kind: "none" }),
          execute: () =>
            primary === "interrupt"
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed({
                  kind: "failed",
                  error: { code: "protocol", message: "Invalid protocol" },
                  exitCode: null,
                  logs: [],
                }),
        };

        const task = activate({ store, executor, graph: graph(), runId: "run" });

        const exit =
          primary === "interrupt"
            ? yield* Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(task);
                yield* Deferred.await(started);
                yield* Fiber.interrupt(fiber);

                return yield* Fiber.await(fiber);
              })
            : yield* Effect.exit(task);

        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isFailure(exit)) {
          const error = exit.cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error)
            .find((error) => error instanceof LeaseReleaseFailed);

          expect(error).toBeInstanceOf(LeaseReleaseFailed);

          if (!(error instanceof LeaseReleaseFailed)) {
            throw new Error("Missing release error");
          }

          if (primary === "graph") {
            expect(Exit.isSuccess(error.primary) && error.primary.value).toEqual({
              status: "failed",
              error: "Invalid protocol",
            });
          } else {
            expect(Exit.isFailure(error.primary)).toBe(true);
          }

          if (primary === "interrupt" && Exit.isFailure(error.primary)) {
            expect(Cause.hasInterrupts(error.primary.cause)).toBe(true);
          }
        }
      }),
    );
  });
}

test("ownership loss interrupts and joins work before fenced release", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const events: string[] = [];

      class LostStore extends MemorySqlStore {
        override heartbeat() {
          return Effect.succeed(false);
        }
        override release(id: string, token: string) {
          return Effect.sync(() => {
            events.push("release");
          }).pipe(Effect.andThen(super.release(id, token)));
        }
      }

      const store = new LostStore({ leaseMs: 1000 });
      yield* store.createRun(newRun());

      const executor: Executor = {
        lookup: () => Effect.succeed({ kind: "none" }),
        execute: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                events.push("stopped");
              }),
            ),
          ),
      };

      const fiber = yield* Effect.forkChild(
        activate({ store, executor, graph: graph(), runId: "run" }),
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust(250);
      const exit = yield* Fiber.await(fiber);
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && reason.error instanceof OwnershipError,
          ),
      ).toBe(true);
      expect(events).toEqual(["stopped", "release"]);
      expect((yield* store.getRun("run"))?.owner).toBeUndefined();
      expect((yield* store.getNodeRuns("run"))[0]).toMatchObject({ status: "running", attempt: 1 });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("consuming first completion never interrupts its sibling", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      let executions = 0;
      let stopped = false;

      class RecordingStore extends MemorySqlStore {
        override apply(batch: Parameters<MemorySqlStore["apply"]>[0]) {
          return super
            .apply(batch)
            .pipe(
              Effect.tap(() =>
                batch.effects.some(
                  (effect) =>
                    effect.kind === "write_node_run" && effect.nodeRun.status === "succeeded",
                )
                  ? Deferred.succeed(waiting, undefined)
                  : Effect.void,
              ),
            );
        }
      }

      const store = new RecordingStore();
      yield* store.createRun(newRun());

      const executor: Executor = {
        lookup: () => Effect.succeed({ kind: "none" }),
        execute: () =>
          Effect.suspend(() => {
            executions++;

            return executions === 1
              ? Effect.succeed({ kind: "succeeded" as const, output: 42, logs: [] })
              : Deferred.await(gate).pipe(
                  Effect.as({ kind: "succeeded" as const, output: 42, logs: [] }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      stopped = true;
                    }),
                  ),
                );
          }),
      };

      const fiber = yield* Effect.forkChild(
        activate({ store, executor, graph: graph(true), runId: "run" }),
      );

      yield* Deferred.await(waiting);
      expect(stopped).toBe(false);
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(fiber)).toMatchObject({ status: "succeeded" });
      expect(executions).toBe(2);
    }),
  );
});

test("apply failure never dispatches uncommitted work and releases the lease", async () => {
  class BrokenStore extends MemorySqlStore {
    override apply() {
      return Effect.fail(unavailable("apply"));
    }
  }

  const store = new BrokenStore();
  const executor = new FakeExecutor();
  await Effect.runPromise(store.createRun(newRun()));

  const exit = await Effect.runPromiseExit(
    activate({ store, executor, graph: graph(), runId: "run" }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(executor.calls).toHaveLength(0);
  expect((await Effect.runPromise(store.getRun("run")))?.owner).toBeUndefined();
});

test("a stalled release reports unknown completion and retains the graph exit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const releasing = yield* Deferred.make<void>();

      class StalledStore extends MemorySqlStore {
        override release() {
          return Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Effect.never));
        }
      }

      const store = new StalledStore();
      yield* store.createRun(newRun());
      const executor = new FakeExecutor();
      executor.result = { kind: "succeeded", output: 42, logs: [] };

      const fiber = yield* Effect.forkChild(
        activate({ store, executor, graph: graph(), runId: "run" }),
      );

      yield* Deferred.await(releasing);
      yield* TestClock.adjust(5000);
      const exit = yield* Fiber.await(fiber);
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && reason.error._tag === "LeaseReleaseUnknown",
          ),
      ).toBe(true);
      expect((yield* store.getRun("run"))?.status).toBe("succeeded");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("interruption of a started receipt never repeats execution or business-cancels the run", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* Deferred.make<void>();
      const store = new MemorySqlStore();
      yield* store.createRun(newRun());
      let executions = 0;

      const executor: Executor = {
        lookup: () =>
          Deferred.succeed(observed, undefined).pipe(Effect.as({ kind: "started" as const })),
        execute: () =>
          Effect.sync(() => {
            executions++;

            return { kind: "succeeded", output: 42, logs: [] };
          }),
      };

      const fiber = yield* Effect.forkChild(
        activate({ store, executor, graph: graph(), runId: "run" }),
      );

      yield* Deferred.await(observed);
      yield* Fiber.interrupt(fiber);
      expect(executions).toBe(0);
      expect((yield* store.getRun("run"))?.status).toBe("suspended");
      expect((yield* store.getNodeRuns("run"))[0]).toMatchObject({ status: "running", attempt: 1 });
    }),
  );
});

for (const primary of ["ownership", "root"] as const) {
  test(`${primary} interruption retains an executor cleanup defect after the inbox consumer stops`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const defect = new Error("executor cleanup defect");

        class LosingStore extends MemorySqlStore {
          override heartbeat() {
            return Effect.succeed(false);
          }
        }

        const store = new LosingStore({ leaseMs: 1000 });

        const executor: Executor = {
          lookup: () => Effect.succeed({ kind: "none" }),
          execute: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.die(defect)),
            ),
        };

        yield* store.createRun(newRun());

        const fiber = yield* Effect.forkChild(
          activate({ store, executor, graph: graph(), runId: "run" }),
        );

        yield* Deferred.await(entered);

        if (primary === "ownership") {
          yield* TestClock.adjust(250);
        } else {
          yield* Fiber.interrupt(fiber);
        }

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isFailure(exit)) {
          const driver = exit.cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error)
            .find((error) => error instanceof DriverCleanupFailed);

          expect(driver).toBeInstanceOf(DriverCleanupFailed);

          if (!(driver instanceof DriverCleanupFailed) || !Exit.isFailure(driver.driver)) {
            throw new Error("Missing driver cleanup");
          }

          const work = driver.driver.cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error)
            .find((error) => error instanceof ActivationWorkCleanupFailed);

          expect(work).toBeInstanceOf(ActivationWorkCleanupFailed);

          if (!(work instanceof ActivationWorkCleanupFailed)) {
            throw new Error("Missing attempt cleanup");
          }

          expect(
            work.attempts.some(
              (attempt) =>
                Exit.isFailure(attempt) &&
                attempt.cause.reasons.some(
                  (reason) => Cause.isDieReason(reason) && reason.defect === defect,
                ),
            ),
          ).toBe(true);
        }

        expect((yield* store.getRun("run"))?.owner).toBeUndefined();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
}
