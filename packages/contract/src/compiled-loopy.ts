import { graphSchema, hashSchema, nodeIdSchema, struct } from "@loopy/core";
import { Schema } from "effect";
import { base64Text } from "./codec";
import { sourceArtifactSchema } from "./source-artifact";

const bundleReferenceSchema = struct({ nodeId: nodeIdSchema, bundleHash: hashSchema });

export const putLoopyBodySchema = struct({
  graph: graphSchema,
  revision: hashSchema,
  bundles: Schema.Array(struct({ ...bundleReferenceSchema.fields, bytes: base64Text })).pipe(
    Schema.mutable,
  ),
  source: struct({ path: Schema.String, workspace: Schema.String }),
  sourceArtifact: Schema.optional(sourceArtifactSchema),
  replace: Schema.Boolean,
});

export type PutLoopyBody = Schema.Schema.Type<typeof putLoopyBodySchema>;

// Description, schedule, mode, secrets, scope and input live in graph.meta and graph.input.
export const savedLoopySchema = struct({
  version: Schema.Literal(3),
  slug: Schema.String,
  graph: graphSchema,
  revision: hashSchema,
  bundles: Schema.Array(bundleReferenceSchema).pipe(Schema.mutable),
  source: Schema.String,
  savedAt: Schema.String,
});

export type SavedLoopy = Schema.Schema.Type<typeof savedLoopySchema>;
