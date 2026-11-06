import { rm } from "node:fs/promises";
import { Effect, Exit, Scope } from "effect";
import { Attempts } from "../../../../apps/sandbox/src/attempt";
import type { AttemptDependencies } from "../../../../apps/sandbox/src/attempt/dependencies";
import { authorityFixture } from "./sandbox-authority";
import { run } from "./sandbox-run";

const roots: string[] = [];

const scopes: Scope.Closeable[] = [];

export async function cleanup() {
  await Promise.all(scopes.splice(0).map((scope) => run(Scope.close(scope, Exit.void))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function fixture() {
  const value = await authorityFixture();
  roots.push(value.root);

  return value;
}

export async function open(
  config: Awaited<ReturnType<typeof fixture>>["config"],
  dependencies: AttemptDependencies,
) {
  const scope = await run(Scope.make());
  scopes.push(scope);

  return run(
    Attempts.open(config, () => Effect.succeed(dependencies)).pipe(
      Effect.provideService(Scope.Scope, scope),
    ),
  );
}
