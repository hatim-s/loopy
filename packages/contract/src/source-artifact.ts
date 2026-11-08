import { hashSchema, nodeIdSchema, positiveInt, struct } from "@loopy/core";
import { Schema } from "effect";
import { boundaryOptions } from "./codec";

export const MAX_SOURCE_BYTES = 256 * 1024;

export const MAX_SOURCE_JSON_BYTES = MAX_SOURCE_BYTES * 2;

export const MAX_SOURCE_FILES = 32;

export const MAX_SOURCE_RANGES = 10_000;

const UNAVAILABLE_SOURCE_REASONS = ["not_captured", "too_large", "redacted"] as const;

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
  startLine: positiveInt,
  endLine: positiveInt,
});

const availableSourceSchema = struct({
  version: Schema.Literal(1),
  status: Schema.Literal("available"),
  revision: hashSchema,
  files: Schema.Array(sourceFileSchema)
    .pipe(Schema.mutable)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(MAX_SOURCE_FILES)),
  ranges: Schema.Array(sourceRangeSchema)
    .pipe(Schema.mutable)
    .check(Schema.isMaxLength(MAX_SOURCE_RANGES)),
});

type AvailableSource = Schema.Schema.Type<typeof availableSourceSchema>;

const encodedBytes = (text: string) => new TextEncoder().encode(text).length;

function tooLarge(artifact: AvailableSource) {
  const bytes = artifact.files.reduce((total, file) => total + encodedBytes(file.content), 0);

  return (
    artifact.files.length > MAX_SOURCE_FILES ||
    artifact.ranges.length > MAX_SOURCE_RANGES ||
    bytes > MAX_SOURCE_BYTES ||
    encodedBytes(JSON.stringify(artifact)) > MAX_SOURCE_JSON_BYTES
  );
}

export const sourceArtifactSchema = Schema.Union([
  availableSourceSchema.check(
    Schema.makeFilter((artifact) => {
      if (tooLarge(artifact)) {
        return `Source files must fit within ${MAX_SOURCE_BYTES / 1024} KiB and use at most ${MAX_SOURCE_JSON_BYTES / 1024} KiB of JSON.`;
      }

      const files = new Map(
        artifact.files.map((file) => [file.id, file.content.split("\n").length]),
      );

      if (files.size !== artifact.files.length) {
        return "Source file ids must be unique.";
      }

      const nodes = new Set<string>();

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
    revision: hashSchema,
    reason: Schema.Literals(UNAVAILABLE_SOURCE_REASONS),
  }),
]);

export type SourceArtifact = Schema.Schema.Type<typeof sourceArtifactSchema>;

export function unavailableSource(
  revision: string,
  reason: (typeof UNAVAILABLE_SOURCE_REASONS)[number],
): SourceArtifact {
  return { version: 1, status: "unavailable", revision, reason };
}

/** A captured artifact that breaks a size limit is reported as too large, any other defect as not captured. */
export function sourceArtifactOrUnavailable(artifact: AvailableSource): SourceArtifact {
  const result = Schema.decodeUnknownResult(sourceArtifactSchema, boundaryOptions)(artifact);

  if (result._tag === "Success") {
    return result.success;
  }

  return unavailableSource(artifact.revision, tooLarge(artifact) ? "too_large" : "not_captured");
}
