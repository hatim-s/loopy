import { type Graph, graphMetaSchema, struct } from "@loopy/core";
import type { Schema } from "effect";
import { type SavedLoopy, savedLoopySchema } from "./compiled-loopy";
import { loopyViewSchema } from "./views";

const { slug, revision, source, savedAt } = savedLoopySchema.fields;

const { scope, description, schedule, mode } = graphMetaSchema.fields;

export const definitionSummarySchema = struct({
  slug,
  revision,
  source,
  savedAt,
  scope,
  description,
  schedule,
  mode,
  input: loopyViewSchema.fields.input,
});

export type DefinitionSummary = Schema.Schema.Type<typeof definitionSummarySchema>;

export function definitionInput(graph: Pick<Graph, "input" | "inputValidation">) {
  return graph.inputValidation?.root === "json" ? "schema" : graph.input;
}

export function definitionSummary(saved: SavedLoopy): DefinitionSummary {
  const { meta } = saved.graph;

  return {
    slug: saved.slug,
    revision: saved.revision,
    source: saved.source,
    savedAt: saved.savedAt,
    scope: meta.scope,
    description: meta.description,
    input: definitionInput(saved.graph),
    schedule: meta.schedule,
    mode: meta.mode,
  };
}
