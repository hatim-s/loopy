import type { SavedLoopy } from "../../contract/index.js";
import { type Json, matchesRecord, type Store } from "../../core/index.js";
import type { Clock } from "../../host/index.js";
import type { Registry } from "../registry.js";
import { ServiceError } from "../service-error.js";

export type ServiceOptions = {
  home: string;
  store: Store;
  registry: (workspace: string) => Registry;
  clock: Clock;
};

export function requireLoopy(registry: Registry, slug: string): SavedLoopy {
  const saved = registry.get(slug);

  if (!saved) {
    throw new ServiceError(
      "not_found",
      `No saved loopy '${slug}'. Use loopy save <file.ts> first.`,
    );
  }

  return saved;
}

export class ServiceContext {
  constructor(protected readonly options: ServiceOptions) {}
  protected now() {
    return new Date(this.options.clock.now()).toISOString();
  }
  protected target(slug: string, workspace: string) {
    const registry = this.options.registry(workspace);

    return { registry, saved: requireLoopy(registry, slug), workspace: registry.project };
  }
  protected validateInput(saved: SavedLoopy, input: Json): Json {
    if (!matchesRecord(saved.graph.input, input, { extraKeys: "reject" })) {
      throw new ServiceError("bad_request");
    }

    return input;
  }
}
