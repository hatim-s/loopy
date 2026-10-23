import { ServiceError } from "./error.js";
import type { ArtifactRegistry } from "./registry.js";

export async function requireDefinition(registry: ArtifactRegistry, slug: string) {
  const saved = await registry.get(slug);

  if (saved === null) {
    throw new ServiceError(
      "not_found",
      `No saved loopy '${slug}'. Use loopy save <file.ts> first.`,
    );
  }

  return saved;
}
