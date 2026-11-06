import type { Schema } from "effect";
import { struct } from "./codec";

import { type SavedLoopy, savedLoopySchema } from "./compiled-loopy";
import type { Graph } from "./graph";
import { loopyViewSchema } from "./views";

export const definitionSummarySchema = struct({
  ...savedLoopySchema.mapFields(
    ({ slug, revision, source, savedAt, scope, description, schedule, mode }) => ({
      slug,
      revision,
      source,
      savedAt,
      scope,
      description,
      schedule,
      mode,
    }),
  ).fields,
  input: loopyViewSchema.fields.input,
});

export type DefinitionSummary = Schema.Schema.Type<typeof definitionSummarySchema>;

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
