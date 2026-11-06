import { Schema } from "effect";
import { struct } from "./codec";

import { nodeIdSchema } from "./graph";

export const MAX_SOURCE_BYTES = 256 * 1024;

export const MAX_SOURCE_FILES = 32;

export const MAX_SOURCE_RANGES = 10_000;

const revisionSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const fileIdSchema = Schema.String.check(Schema.isPattern(/^file-[0-9]+$/));

const sourceFileSchema = struct({
  id: fileIdSchema,
  path: Schema.String.check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(255))
    .check(Schema.isPattern(/^[^/\\\0]+$/))
    .check(Schema.makeFilter((path) => path !== "." && path !== "..")),
  content: Schema.String.check(Schema.isMaxLength(MAX_SOURCE_BYTES)),
});

const sourceRangeSchema = struct({
  nodeId: nodeIdSchema,
  fileId: fileIdSchema,
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const sourceArtifactSchema = Schema.Union([
  struct({
    version: Schema.Literal(1),
    status: Schema.Literal("available"),
    revision: revisionSchema,
    files: Schema.Array(sourceFileSchema)
      .pipe(Schema.mutable)
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(MAX_SOURCE_FILES)),
    ranges: Schema.Array(sourceRangeSchema)
      .pipe(Schema.mutable)
      .check(Schema.isMaxLength(MAX_SOURCE_RANGES)),
  }).check(
    Schema.makeFilter((artifact) => {
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
        return "Source files must be unique, fit within 256 KiB, and use at most 512 KiB of JSON.";
      }

      for (const range of artifact.ranges) {
        const lines = files.get(range.fileId);

        if (
          lines === undefined ||
          range.endLine < range.startLine ||
          range.endLine > lines ||
          nodes.has(range.nodeId)
        ) {
          return "Source ranges must name a unique node and valid file lines.";
        }

        nodes.add(range.nodeId);
      }

      return true;
    }),
  ),
  struct({
    version: Schema.Literal(1),
    status: Schema.Literal("unavailable"),
    revision: revisionSchema,
    reason: Schema.Literals(["not_captured", "too_large", "redacted"]),
  }),
]);

export type SourceArtifact = Schema.Schema.Type<typeof sourceArtifactSchema>;
