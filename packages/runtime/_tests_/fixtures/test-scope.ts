import { afterAll, onTestFinished } from "bun:test";
import { Effect, Exit, Scope } from "effect";

let running: Scope.Closeable | undefined;

/**
 * The running test's scope. Bun evaluates a shared fixture module once per process, so a
 * top-level afterEach there binds only to the first test file. onTestFinished binds to the
 * test that allocates, and the single scope releases fixtures in reverse allocation order.
 * Call it inside a test or beforeEach. Inside beforeAll it would close before the first test.
 */
export function fixtureScope(): Scope.Scope {
  if (running !== undefined) {
    return running;
  }

  const scope = Scope.makeUnsafe();
  running = scope;

  onTestFinished(async () => {
    running = undefined;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  return scope;
}

/** A scope closed after the calling file's last test. Call it at the top level of a test file. */
export function fileScope(): Scope.Scope {
  const scope = Scope.makeUnsafe();
  afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

  return scope;
}

/** Runs a scoped effect whose resources live until the scope closes. */
export const runScoped = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
  scope: Scope.Scope = fixtureScope(),
) => Effect.runPromise(effect.pipe(Effect.provideService(Scope.Scope, scope)));

/** Releases a non-Effect resource with the scope. */
export function onCleanup(
  release: () => void | Promise<void>,
  scope: Scope.Scope = fixtureScope(),
) {
  Effect.runSync(
    Scope.addFinalizer(
      scope,
      Effect.promise(async () => release()),
    ),
  );
}
