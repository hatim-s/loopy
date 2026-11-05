import { Schema } from "effect";
import { struct } from "./codec.js";

import { graphMetaSchema, graphSchema, nodeIdSchema } from "./graph.js";
import { sourceArtifactSchema } from "./source-artifact.js";

export const hashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const bundleReferenceSchema = struct({ nodeId: nodeIdSchema, bundleHash: hashSchema });

export const sourceMetadataSchema = struct({ path: Schema.String, workspace: Schema.String });

export const putLoopyBodySchema = struct({
  graph: graphSchema,
  revision: hashSchema,
  bundles: Schema.Array(
    struct({
      ...bundleReferenceSchema.fields,
      bytes: Schema.String.check(
        Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      ),
    }),
  ).pipe(Schema.mutable),
  source: sourceMetadataSchema,
  sourceArtifact: Schema.optional(sourceArtifactSchema),
  replace: Schema.Boolean,
});

export type PutLoopyBody = Schema.Schema.Type<typeof putLoopyBodySchema>;

export const savedLoopySchema = struct({
  version: Schema.Literal(2),
  slug: Schema.String,
  scope: graphMetaSchema.fields.scope,
  graph: graphSchema,
  revision: hashSchema,
  bundles: Schema.Array(bundleReferenceSchema).pipe(Schema.mutable),
  source: Schema.String,
  description: Schema.NullOr(Schema.String),
  input: graphSchema.fields.input,
  schedule: graphMetaSchema.fields.schedule,
  mode: graphMetaSchema.fields.mode,
  secrets: graphMetaSchema.fields.secrets,
  savedAt: Schema.String,
});

export type SavedLoopy = Schema.Schema.Type<typeof savedLoopySchema>;
