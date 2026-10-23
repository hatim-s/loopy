import type { z } from "zod";
import { type SavedLoopy, savedLoopySchema } from "./compiled-loopy.js";
import type { Graph } from "./graph.js";
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

export function definitionInput(graph: Pick<Graph, "input" | "inputValidation">) {
  return graph.inputValidation?.root === "json" ? "schema" : graph.input;
}

export function definitionSummary(saved: SavedLoopy): DefinitionSummary {
  return {
    slug: saved.slug,
    revision: saved.revision,
    source: saved.source,
    savedAt: saved.savedAt,
    scope: saved.scope,
    description: saved.description,
    input: definitionInput({ input: saved.input, inputValidation: saved.graph.inputValidation }),
    schedule: saved.schedule,
    mode: saved.mode,
  };
}
