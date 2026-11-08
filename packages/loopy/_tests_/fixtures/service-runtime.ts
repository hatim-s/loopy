import type { Store } from "@loopy/core";
import { type DaemonOptions, makeDaemon } from "@loopy/runtime/host";
import { openRunStore } from "@loopy/runtime/store";
import { Clock, Effect } from "effect";
import { fixedClock } from "../store-fixture";
import { runScoped } from "./test-scope";

export const fixtureStore = (home: string) => runScoped(openRunStore(home));

// A real-time pause, so polling also makes progress while a TestClock holds Effect time still.
const pause = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));

export const waitUntil = <E, R>(check: Effect.Effect<boolean, E, R>, attempts = 5000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (yield* check) {
        return;
      }

      yield* pause;
    }

    return yield* Effect.die(new Error("The awaited store state never settled."));
  });

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
      yield* waitUntil(Effect.sync(() => passes() >= target));
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
