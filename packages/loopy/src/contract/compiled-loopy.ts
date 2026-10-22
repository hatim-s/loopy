import { z } from "zod";
import { graphMetaSchema, graphSchema, nodeIdSchema } from "./graph.js";
import { sourceArtifactSchema } from "./source-artifact.js";

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const bundleReferenceSchema = z.strictObject({
  nodeId: nodeIdSchema,
  bundleHash: hashSchema,
});

export const sourceMetadataSchema = z.strictObject({
  path: z.string(),
  workspace: z.string(),
});

export const putLoopyBodySchema = z.strictObject({
  graph: graphSchema,
  revision: hashSchema,
  bundles: z.array(
    bundleReferenceSchema.extend({
      bytes: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    }),
  ),
  source: sourceMetadataSchema,
  sourceArtifact: sourceArtifactSchema.optional(),
  replace: z.boolean(),
});

export type PutLoopyBody = z.infer<typeof putLoopyBodySchema>;

export const savedLoopySchema = z.strictObject({
  version: z.literal(2),
  slug: z.string(),
  scope: graphMetaSchema.shape.scope,
  graph: graphSchema,
  revision: hashSchema,
  bundles: z.array(bundleReferenceSchema),
  source: z.string(),
  description: z.string().nullable(),
  input: graphSchema.shape.input,
  schedule: graphMetaSchema.shape.schedule,
  mode: graphMetaSchema.shape.mode,
  secrets: graphMetaSchema.shape.secrets,
  savedAt: z.string(),
});

export type SavedLoopy = z.infer<typeof savedLoopySchema>;
