import type { ProviderAdapter, ProviderId, ProviderRegistry } from "./types";

export function createProviderRegistry(
  adapters: readonly ProviderAdapter[] = [],
): ProviderRegistry {
  const entries = new Map<ProviderId, ProviderAdapter>();
  const registry: ProviderRegistry = {
    register(adapter) {
      if (entries.has(adapter.id))
        throw new Error(`Provider '${adapter.id}' is already registered.`);
      entries.set(adapter.id, adapter);
      return registry;
    },
    get(id) {
      return entries.get(id);
    },
    all() {
      return [...entries.values()];
    },
  };
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
