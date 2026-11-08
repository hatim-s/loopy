import { Effect, Exit, Scope } from "effect";
import { failure, type SandboxOperationError } from "./operations";

/**
 * Opens a resource in its own scope with an idempotent close, so a caller can close it early
 * while the enclosing scope still owns the release and observes the same release failure.
 */
export function closeableScope<A, E, R>(
  release: { operation: string; message: string },
  open: (close: Effect.Effect<void, SandboxOperationError>) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();

    const close = yield* Effect.cached(
      Scope.close(scope, Exit.void).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(failure(release.operation, cause, release.message)),
        ),
        Effect.uninterruptible,
      ),
    );

    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));

    return yield* open(close).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? close.pipe(Effect.orDie) : Effect.void)),
    );
  });
}
