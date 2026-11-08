import type { DashboardReader } from "@loopy/contract";
import type { Store } from "@loopy/core";
import { Effect } from "effect";
import { canonicalPath, SecretStore } from "../os";
import { GenerationError, makeService, WorkspaceError } from "../service";
import { Registry } from "./registry";
import { makeArtifactRegistry } from "./save-compiled";
import { generateCommand } from "./typegen/generate";

export { ServiceError } from "../service";

export function makeLocalService(options: { home: string; store: Store & DashboardReader }) {
  return makeService({
    store: options.store,
    registry: (workspace) =>
      Registry.make(options.home, workspace).pipe(Effect.map(makeArtifactRegistry)),
    canonicalWorkspace: (workspace) =>
      Effect.try({
        try: () => canonicalPath(workspace),
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
