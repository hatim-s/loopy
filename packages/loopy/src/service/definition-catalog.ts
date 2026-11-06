import { Effect } from "effect";
import type { DefinitionSummary } from "../contract";
import type { ArtifactRegistry, ServiceOptions } from "./registry";

/** One request caches absence and aliases by the registry's canonical workspace. */
export function makeDefinitionCatalog(selectRegistry: ServiceOptions["registry"]) {
  const registries = new Map<string, ArtifactRegistry>();
  const workspaceSummaries = new Map<string, Map<string, DefinitionSummary | null>>();
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

  const summary = Effect.fn("definition-catalog.summary")(function* (
    workspace: string,
    slug: string,
  ) {
    const { registry, identity } = yield* resolve(workspace);

    const summaries =
      workspaceSummaries.get(identity) ?? new Map<string, DefinitionSummary | null>();

    workspaceSummaries.set(identity, summaries);

    if (summaries.has(slug)) {
      return summaries.get(slug) ?? null;
    }

    const summary = lists.has(identity) ? null : yield* registry.summary(slug);
    summaries.set(slug, summary);

    return summary;
  });

  const list = Effect.fn("definition-catalog.list")(function* (workspace: string) {
    const { registry, identity } = yield* resolve(workspace);
    const cached = lists.get(identity);

    if (cached) {
      return cached;
    }

    const entries = yield* registry.listSummaries();
    workspaceSummaries.set(identity, new Map(entries.map((entry) => [entry.slug, entry])));
    lists.set(identity, entries);

    return entries;
  });

  return { resolve, summary, list };
}

export type DefinitionCatalog = ReturnType<typeof makeDefinitionCatalog>;
