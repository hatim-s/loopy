import type { ArtifactIdentity, ArtifactStore } from "../application/ports.js";
import type { AttemptRecord, CommandOutput, Json, ResolvedCommand } from "../core/model.js";
import { assertJson } from "./values.js";

export type CommandOutputReference = { $commandOutput: ArtifactIdentity };
export type ResolvedCommandReference = { $resolvedCommand: ArtifactIdentity };

export async function putExecutionArtifact(
  store: ArtifactStore,
  value: CommandOutput | ResolvedCommand,
): Promise<ArtifactIdentity> {
  return await store.put(new TextEncoder().encode(JSON.stringify(value)));
}
export async function getExecutionArtifact<T extends CommandOutput | ResolvedCommand>(
  store: ArtifactStore,
  identity: ArtifactIdentity,
): Promise<T> {
  const bytes = await store.get(identity);
  if (!bytes) throw new Error("Execution artifact unavailable");
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  assertJson(value);
  return value as T;
}

/** Persisted attempts hold content references; consumers receive the original logical values. */
export async function hydrateAttempts(
  attempts: readonly AttemptRecord[],
  store: ArtifactStore,
): Promise<AttemptRecord[]> {
  return await Promise.all(
    attempts.map(async (attempt) => {
      const hydrated = { ...attempt };
      if (isReference(attempt.input, "$resolvedCommand"))
        hydrated.input = (await getExecutionArtifact<ResolvedCommand>(
          store,
          attempt.input.$resolvedCommand,
        )) as Json;
      if (isReference(attempt.output, "$commandOutput"))
        hydrated.output = (await getExecutionArtifact<CommandOutput>(
          store,
          attempt.output.$commandOutput,
        )) as Json;
      return hydrated;
    }),
  );
}
function isReference<K extends string>(
  value: Json | undefined,
  key: K,
): value is Json & Record<K, ArtifactIdentity> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key)
  );
}
