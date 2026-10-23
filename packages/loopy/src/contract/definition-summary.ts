import type { z } from "zod";
import { type SavedLoopy, savedLoopySchema } from "./compiled-loopy.js";
import { loopyViewSchema } from "./views.js";

export const definitionSummarySchema = savedLoopySchema
  .pick({
    slug: true,
    revision: true,
    source: true,
    savedAt: true,
    scope: true,
    description: true,
    schedule: true,
    mode: true,
  })
  .extend({ input: loopyViewSchema.shape.input });

export type DefinitionSummary = z.infer<typeof definitionSummarySchema>;

export function definitionSummary(saved: SavedLoopy): DefinitionSummary {
  return {
    slug: saved.slug,
    revision: saved.revision,
    source: saved.source,
    savedAt: saved.savedAt,
    scope: saved.scope,
    description: saved.description,
    input: saved.graph.inputValidation?.root === "json" ? "schema" : saved.input,
    schedule: saved.schedule,
    mode: saved.mode,
  };
}
