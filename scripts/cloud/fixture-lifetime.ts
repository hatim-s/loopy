import { Effect } from "effect";

/** A service may still own monitors and locks when its caller is interrupted. */
export function registerFixtureCleanup<E, R, E2, R2>(
  close: () => Effect.Effect<void, E, R>,
  cleanup: Effect.Effect<void, E2, R2>,
) {
  return Effect.addFinalizer(() =>
    Effect.suspend(close).pipe(Effect.andThen(cleanup), Effect.orDie),
  );
}
