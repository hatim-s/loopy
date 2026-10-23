import type { DefinitionSummary } from "../contract/index.js";
import type { ArtifactRegistry, ServiceOptions } from "./registry.js";

/** One request caches absence and aliases by the registry's canonical workspace. */
export class DefinitionCatalog {
  private readonly registries = new Map<string, ArtifactRegistry>();
  private readonly summaries = new Map<string, Map<string, DefinitionSummary | null>>();
  private readonly lists = new Map<string, DefinitionSummary[]>();

  constructor(private readonly registry: ServiceOptions["registry"]) {}

  async resolve(workspace: string) {
    const cached = this.registries.get(workspace);

    if (cached) {
      return { registry: cached, identity: await cached.workspace() };
    }

    const registry = this.registry(workspace);
    const identity = await registry.workspace();
    const resolved = this.registries.get(identity) ?? registry;
    this.registries.set(identity, resolved);
    this.registries.set(workspace, resolved);

    return { registry: resolved, identity };
  }

  async summary(workspace: string, slug: string): Promise<DefinitionSummary | null> {
    const { registry, identity } = await this.resolve(workspace);
    const summaries = this.summaries.get(identity) ?? new Map<string, DefinitionSummary | null>();
    this.summaries.set(identity, summaries);

    if (summaries.has(slug)) {
      return summaries.get(slug) ?? null;
    }

    const summary = this.lists.has(identity) ? null : await registry.summary(slug);
    summaries.set(slug, summary);

    return summary;
  }

  async list(workspace: string): Promise<DefinitionSummary[]> {
    const { registry, identity } = await this.resolve(workspace);
    const cached = this.lists.get(identity);

    if (cached) {
      return cached;
    }

    const entries = await registry.listSummaries();
    this.summaries.set(identity, new Map(entries.map((entry) => [entry.slug, entry])));
    this.lists.set(identity, entries);

    return entries;
  }
}
