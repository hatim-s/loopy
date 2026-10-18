import { z } from "zod";
import { graphSchema } from "./graph.js";
import { utcTimestamp } from "./primitives.js";

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const sourceMetadataSchema = z.strictObject({
  path: z.string(),
  workspace: z.string(),
});

export const putLoopyBodySchema = z.strictObject({
  graph: graphSchema,
  revision: hashSchema,
  bundles: z.array(z.base64()),
  source: sourceMetadataSchema,
  replace: z.boolean(),
});

export type PutLoopyBody = z.infer<typeof putLoopyBodySchema>;

export const savedLoopySchema = z.strictObject({
  version: z.literal(2),
  revision: hashSchema,
  source: z.string(),
  graph: graphSchema,
  savedAt: utcTimestamp,
});

export type SavedLoopy = z.infer<typeof savedLoopySchema>;
