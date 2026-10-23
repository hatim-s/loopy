import { definitionSummary } from "../contract/index.js";
import type { Store } from "../core/index.js";
import type { Clock } from "../host/index.js";
import { LoopyService as PortableService } from "../service/index.js";
import { canonicalPath } from "./fs.js";
import { type Registry, RegistryMissingError } from "./registry.js";
import { saveCompiled } from "./save-compiled.js";
import { SecretStore } from "./secrets.js";
import { generateCommand } from "./typegen/generate.js";

export { ServiceError } from "../service/index.js";

function currentDefinition(registry: Registry, slug: string) {
  try {
    return registry.get(slug);
  } catch (error) {
    if (error instanceof RegistryMissingError) {
      return null;
    }

    throw error;
  }
}

export class LoopyService extends PortableService {
  constructor(options: {
    store: Store;
    registry: (workspace: string) => Registry;
    clock: Clock;
  }) {
    super({
      store: options.store,
      clock: options.clock,
      canonicalWorkspace: canonicalPath,
      registry: (workspace) => {
        const registry = options.registry(workspace);

        return {
          workspace: async () => registry.project,
          listSummaries: async () => registry.list().map(definitionSummary),
          summary: async (slug) => {
            const saved = currentDefinition(registry, slug);

            return saved ? definitionSummary(saved) : null;
          },
          get: async (slug) => currentDefinition(registry, slug),
          revisionGraph: (revision) => registry.revisionGraph(revision),
          revisionSource: (slug, revision) => registry.revisionSource(slug, revision),
          save: async (body) => {
            await saveCompiled(registry, body);
          },
        };
      },
      secrets: {
        list: () => new SecretStore(options.registry("").home).list(),
        set: (name, value) => {
          new SecretStore(options.registry("").home).set(name, value);
        },
        remove: (name) => {
          new SecretStore(options.registry("").home).remove(name);
        },
      },
      generateTypes: (body) =>
        generateCommand(body.binary, body.path, { name: body.name ?? undefined }),
    });
  }
}
