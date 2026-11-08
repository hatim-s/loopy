import { expect, test } from "bun:test";
import { decodeBoundary } from "@loopy/contract";
import { CommandExecutionError } from "@loopy/core";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { sandboxConfigSchema } from "../../../sandbox/src/config";
import { FixtureError, fixtureFailure } from "../../dev/fixture-effect";
import { registerFixtureCleanup } from "../../dev/fixture-lifetime";
import { JourneyFailure } from "../../dev/journey/client";
import { TransportFaults } from "../../dev/transport-failure/faults";
import { until } from "../../dev/transport-failure/resources";
import { withWaitClient } from "../../dev/wait-client";

const config = decodeBoundary(sandboxConfigSchema)({
  worktree: "/synthetic/worktree",
  stateRoot: "/synthetic/state",
  token: "fixture-token-with-enough-characters",
  dockerContext: "fixture",
  image: "fixture",
  port: 0,
});

const argv: [string, ...string[]] = ["docker", "--context", "fixture", "info"];

const options = { cwd: "/synthetic/worktree", env: {}, timeoutMs: 1000 };

test("typed runner failures retain their cause and release active call accounting", async () => {
  const failure = new CommandExecutionError({
    reason: "timeout",
    message: "fixture timeout",
    cause: undefined,
    output: { stdout: "", stderr: "", exitCode: -1, durationMs: 0 },
  });

  const faults = new TransportFaults(config, "kill_wait_client", () => Effect.fail(failure));
  const exit = await Effect.runPromise(Effect.exit(faults.runner(argv, options)));
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure);
  expect(faults.activeCalls).toBe(0);
});

test("runner interruption joins its injected operation before releasing accounting", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let stopped = false;

      const faults = new TransportFaults(config, "kill_wait_client", () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              stopped = true;
            }),
          ),
        ),
      );

      const fiber = yield* Effect.forkChild(faults.runner(argv, options));
      yield* Deferred.await(entered);
      expect(faults.activeCalls).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(stopped).toBe(true);
      expect(faults.activeCalls).toBe(0);
    }),
  );
});

test("interrupted observation performs no later reads", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let reads = 0;

      const fiber = yield* Effect.forkChild(
        until(
          () =>
            Effect.sync(() => {
              reads++;
            }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.as(false)),
          Boolean,
        ),
      );

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const stoppedAt = reads;
      yield* Effect.yieldNow;
      expect(reads).toBe(stoppedAt);
    }),
  );
});

test("wait client interruption kills and joins all owned streams before returning", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const killed = yield* Deferred.make<void>();
      const streams = Promise.withResolvers<string>();
      const exited = Promise.withResolvers<number>();
      let stopped = false;
      let interrupted = false;

      const fiber = yield* Effect.forkChild(
        withWaitClient(
          Effect.sync(() => ({
            pid: 123,
            get exitCode() {
              return stopped ? 137 : null;
            },
            kill: () => {
              stopped = true;
              exited.resolve(137);
              Effect.runSync(Deferred.succeed(killed, undefined));
            },
            exited: exited.promise,
            stdout: streams.promise,
            stderr: streams.promise,
          })),
          () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );

      yield* Deferred.await(entered);

      const interrupter = yield* Effect.forkChild(
        Fiber.interrupt(fiber).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      );

      yield* Deferred.await(killed);
      expect(stopped).toBe(true);
      expect(interrupted).toBe(false);
      streams.resolve("");
      yield* Fiber.join(interrupter);
      expect(interrupted).toBe(true);
    }),
  );
});

test("interruption closes and joins the current service before fixture cleanup checks its lock", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const joined = yield* Deferred.make<void>();
      const order: string[] = [];
      let locked = true;
      let cleaned = false;

      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerFixtureCleanup(
              () =>
                Effect.gen(function* () {
                  order.push("close");
                  yield* Deferred.succeed(closing, undefined);
                  yield* Deferred.await(joined);
                  locked = false;
                  order.push("joined");
                }),
              Effect.sync(() => {
                expect(locked).toBe(false);
                order.push("cleanup");
                cleaned = true;
              }),
            );
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }),
        ),
      );

      yield* Deferred.await(entered);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Deferred.await(closing);
      expect(cleaned).toBe(false);
      yield* Deferred.succeed(joined, undefined);
      yield* Fiber.join(interruption);
      expect(order).toEqual(["close", "joined", "cleanup"]);
    }),
  );
});

test("failure projection preserves observation timeout text and safe assertion evidence", () => {
  const timeout = new FixtureError({
    operation: "observation",
    cause: undefined,
    message: "Transport fixture observation timed out.",
  });

  expect(fixtureFailure(timeout).failure).toBe(timeout.message);
  const assertion = new JourneyFailure({ failure: "fixture_assertion", expected: 1 });
  expect(fixtureFailure(assertion).failureEvidence).toEqual(assertion.evidence);
});

test("wait client shutdown fails visibly when an owned stream cannot join within its bound", async () => {
  const exit = await Effect.runPromise(
    Effect.exit(
      withWaitClient(
        Effect.succeed({
          pid: 123,
          exitCode: 137,
          kill: () => {},
          exited: Promise.resolve(137),
          stdout: new Promise<string>(() => {}),
          stderr: Promise.resolve(""),
        }),
        () => Effect.void,
        { shutdownMs: 1 },
      ),
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(fixtureFailure(Cause.squash(exit.cause)).failure).toContain(
      "Wait client shutdown did not finish",
    );
  }
});
