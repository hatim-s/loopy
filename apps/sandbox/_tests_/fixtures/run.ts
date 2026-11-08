import { Effect, Exit, Scope } from "effect";
import { fixtureScope } from "../../../../packages/runtime/_tests_/fixtures/test-scope";
import { Attempts } from "../../src/attempt";
import type {
  AttemptDependencies,
  AttemptDependenciesFactory,
} from "../../src/attempt/dependencies";
import type { SandboxConfig } from "../../src/config";
import { startSandbox } from "../../src/server";

export const run = Effect.runPromise;

// A child of the test scope releases a failed open at once, so a racing open can take the lock.
function openScoped<A, E>(open: (scope: Scope.Closeable) => Effect.Effect<A, E, Scope.Scope>) {
  const scope = Scope.forkUnsafe(fixtureScope());

  return run(
    open(scope).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    ),
  );
}

export function openSandbox(config: SandboxConfig, dependencies: AttemptDependenciesFactory) {
  return openScoped((scope) =>
    Effect.map(startSandbox(config, dependencies), (service) => ({
      ...service,
      close: () => service.close().pipe(Effect.ensuring(Scope.close(scope, Exit.void))),
    })),
  );
}

export function openAttempts(config: SandboxConfig, dependencies: AttemptDependenciesFactory) {
  return openScoped(() => Attempts.open(config, dependencies));
}

export function openAttemptsWith(config: SandboxConfig, dependencies: AttemptDependencies) {
  return openAttempts(config, () => Effect.succeed(dependencies));
}
