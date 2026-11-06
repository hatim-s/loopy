import { Effect, Exit, Scope } from "effect";
import { Attempts } from "../../../../apps/sandbox/src/attempt";
import type { AttemptDependenciesFactory } from "../../../../apps/sandbox/src/attempt/dependencies";
import type { SandboxConfig } from "../../../../apps/sandbox/src/config";
import { startSandbox } from "../../../../apps/sandbox/src/server";

export const run = Effect.runPromise;

// Bun tests own scopes explicitly so assertions can span more than one runtime call.
export async function openSandbox(config: SandboxConfig, dependencies: AttemptDependenciesFactory) {
  const scope = await run(Scope.make());

  const service = await run(
    startSandbox(config, dependencies).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    ),
  );

  return {
    ...service,
    close: () => service.close().pipe(Effect.ensuring(Scope.close(scope, Exit.void))),
  };
}

const attemptScopes: Scope.Closeable[] = [];

export async function openAttempts(
  config: SandboxConfig,
  dependencies: AttemptDependenciesFactory,
) {
  const scope = await run(Scope.make());
  attemptScopes.push(scope);

  return run(
    Attempts.open(config, dependencies).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    ),
  );
}

export async function closeAttemptScopes() {
  await Promise.all(attemptScopes.splice(0).map((scope) => run(Scope.close(scope, Exit.void))));
}
