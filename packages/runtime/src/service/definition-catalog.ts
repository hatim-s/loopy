import type { DefinitionSummary } from "@loopy/contract";
import { Effect } from "effect";
import type { ArtifactRegistry, ServiceOptions } from "./registry";

/** One request caches registries and listings by the registry's canonical workspace. */
export function makeDefinitionCatalog(selectRegistry: ServiceOptions["registry"]) {
  const registries = new Map<string, ArtifactRegistry>();
  const lists = new Map<string, DefinitionSummary[]>();

  const resolve = Effect.fn("definition-catalog.resolve")(function* (workspace: string) {
    const cached = registries.get(workspace);

    if (cached) {
      return { registry: cached, identity: yield* cached.workspace() };
    }

    const registry = yield* selectRegistry(workspace);
    const identity = yield* registry.workspace();
    const resolved = registries.get(identity) ?? registry;
    registries.set(identity, resolved);
    registries.set(workspace, resolved);

    return { registry: resolved, identity };
  });

  const list = Effect.fn("definition-catalog.list")(function* (workspace: string) {
    const { registry, identity } = yield* resolve(workspace);
    const cached = lists.get(identity);

    if (cached) {
      return cached;
    }

    const entries = yield* registry.listSummaries();
    lists.set(identity, entries);

    return entries;
  });

  return { resolve, list };
}

export type DefinitionCatalog = ReturnType<typeof makeDefinitionCatalog>;
