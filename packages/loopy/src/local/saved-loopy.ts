import { savedLoopySchema } from "../contract/index.js";
import { validateSlug } from "../core/index.js";

export type { SavedLoopy } from "../contract/index.js";

// BOUNDARY: Registry entries are JSON read from disk.
export function parseSavedLoopy(input: unknown) {
  const entry = savedLoopySchema.parse(input);
  validateSlug(entry.slug);

  return entry;
}
