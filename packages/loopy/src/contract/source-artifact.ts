import { z } from "zod";
import { nodeIdSchema } from "./graph.js";

export const MAX_SOURCE_BYTES = 256 * 1024;

export const MAX_SOURCE_FILES = 32;

export const MAX_SOURCE_RANGES = 10_000;

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

const fileIdSchema = z.string().regex(/^file-[0-9]+$/);

const sourceFileSchema = z.strictObject({
  id: fileIdSchema,
  path: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\0]+$/)
    .refine((path) => path !== "." && path !== ".."),
  content: z.string().max(MAX_SOURCE_BYTES),
});

const sourceRangeSchema = z.strictObject({
  nodeId: nodeIdSchema,
  fileId: fileIdSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

export const sourceArtifactSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      version: z.literal(1),
      status: z.literal("available"),
      revision: revisionSchema,
      files: z.array(sourceFileSchema).min(1).max(MAX_SOURCE_FILES),
      ranges: z.array(sourceRangeSchema).max(MAX_SOURCE_RANGES),
    })
    .superRefine((artifact, context) => {
      const files = new Map(
        artifact.files.map((file) => [file.id, file.content.split("\n").length]),
      );

      const bytes = artifact.files.reduce(
        (total, file) => total + new TextEncoder().encode(file.content).length,
        0,
      );

      const nodes = new Set<string>();

      if (
        files.size !== artifact.files.length ||
        bytes > MAX_SOURCE_BYTES ||
        new TextEncoder().encode(JSON.stringify(artifact)).length > MAX_SOURCE_BYTES * 2
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Source files must be unique, fit within 256 KiB, and use at most 512 KiB of JSON.",
        });
      }

      for (const range of artifact.ranges) {
        const lines = files.get(range.fileId);

        if (
          lines === undefined ||
          range.endLine < range.startLine ||
          range.endLine > lines ||
          nodes.has(range.nodeId)
        ) {
          context.addIssue({
            code: "custom",
            message: "Source ranges must name a unique node and valid file lines.",
          });
        }

        nodes.add(range.nodeId);
      }
    }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("unavailable"),
    revision: revisionSchema,
    reason: z.enum(["not_captured", "too_large", "redacted"]),
  }),
]);

export type SourceArtifact = z.infer<typeof sourceArtifactSchema>;
