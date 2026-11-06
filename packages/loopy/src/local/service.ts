import { Effect } from "effect";
import type { Store } from "../core";
import { GenerationError, makeService, WorkspaceError } from "../service";
import { canonicalPath } from "./fs";
import { Registry } from "./registry";
import { makeArtifactRegistry } from "./save-compiled";
import { SecretStore } from "./secrets";
import { generateCommand } from "./typegen/generate";

export { ServiceError } from "../service";

export function makeLocalService(options: {
  home: string;
  cwd: string;
  store: Store;
  clock: { now(): number };
}) {
  return makeService({
    store: options.store,
    clock: options.clock,
    registry: (workspace) =>
      Registry.make(options.home, workspace || options.cwd).pipe(Effect.map(makeArtifactRegistry)),
    canonicalWorkspace: (workspace) =>
      Effect.try({
        try: () => canonicalPath(workspace || options.cwd),
        catch: (cause) => new WorkspaceError({ cause }),
      }),
    secrets: new SecretStore(options.home),
    // TypeGenerationError contains raw process output. Keep it in the internal Cause.
    generateTypes: (body) =>
      generateCommand(body.binary, body.path, { name: body.name ?? undefined }).pipe(
        Effect.mapError((cause) => new GenerationError({ cause })),
      ),
  });
}

export type LocalService = ReturnType<typeof makeLocalService>;
