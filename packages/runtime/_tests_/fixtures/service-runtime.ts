import type { Store } from "@loopy/core";
import { Clock, Effect } from "effect";
import { type DaemonOptions, makeDaemon } from "../../src/host";
import { openRunStore } from "../../src/store";
import { fixedClock } from "./clock";
import { runScoped } from "./test-scope";
import { eventually } from "./wait";

export const fixtureStore = (home: string) => runScoped(openRunStore(home));

/** Each daemon pass fires due schedules and then reads due runs, so dueRuns calls count passes. */
export function countPasses(store: Pick<Store, "dueRuns">) {
  let passes = 0;
  const dueRuns = store.dueRuns.bind(store);

  store.dueRuns = (now) =>
    dueRuns(now).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          passes++;
        }),
      ),
    );

  return () => passes;
}

// The first wake may land in a pass that began earlier, so two passes prove one started after the call.
export const nextPass = (daemon: { wake: Effect.Effect<void> }, passes: () => number) =>
  Effect.gen(function* () {
    const before = passes();

    for (const target of [before + 1, before + 2]) {
      yield* daemon.wake;
      yield* eventually(
        `daemon pass ${target}`,
        Effect.sync(() => passes() >= target),
      );
    }
  });

/** Starts the daemon loop under the service clock. The fixture scope stops it after the test. */
export function fixtureDaemon(options: DaemonOptions & { clock: { now(): number } }) {
  const passes = countPasses(options.store);

  return runScoped(
    Effect.gen(function* () {
      const daemon = yield* makeDaemon(options);
      yield* Effect.forkScoped(daemon.run);

      return { ...daemon, passes, pass: nextPass(daemon, passes) };
    }).pipe(Effect.provideService(Clock.Clock, fixedClock(options.clock.now))),
  );
}
