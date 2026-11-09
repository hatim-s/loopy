import { resolve } from "node:path";
import { decodeBoundary, encodeBoundary, isoDateTime } from "@loopy/contract";
import { Schema } from "effect";
import { atomic } from "../files";
import { groupSchema } from "../journal";
import { processRowSchema } from "./resources";
import { distributionSchema, endpointSummarySchema, sampleSchema } from "./statistics";

// Each metrics artifact has one file name, one schema and one producing command, so a reader
// that runs before its producer says which command to run.

export const phaseNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));

export const decodePhaseName = decodeBoundary(phaseNameSchema);

type Artifact<T> = {
  file: string;
  producer: string;
  schema: Schema.Codec<T, unknown, never, never>;
};

const resourceSampleSchema = Schema.Struct({
  at: Schema.String,
  host: Schema.Struct({
    cpus: Schema.Int,
    freeBytes: Schema.Number,
    totalBytes: Schema.Number,
    load: Schema.Array(Schema.Number),
  }),
  sampler: Schema.Struct({
    memory: Schema.Record(Schema.String, Schema.Number),
    cpu: Schema.Record(Schema.String, Schema.Number),
  }),
  processes: Schema.NullOr(Schema.Array(processRowSchema)),
  disk: Schema.NullOr(Schema.String),
  limits: Schema.String,
});

export const captureSchema = Schema.Struct({
  scope: Schema.Literal("local-playground-read-only-api"),
  phase: phaseNameSchema,
  startedAt: isoDateTime,
  updatedAt: isoDateTime,
  elapsedMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  targetRequestsPerSecond: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  samples: Schema.Array(sampleSchema),
  summaries: Schema.Array(endpointSummarySchema),
  resources: Schema.Array(resourceSampleSchema),
  limits: Schema.Array(Schema.String),
  api: Schema.String,
  dashboard: Schema.String,
  batch: Schema.String,
  workspace: Schema.Literal("playground"),
  workloadControls: Schema.Struct({ apiSlots: Schema.Int, runtimeAttempts: Schema.Int }),
});

export type Capture = typeof captureSchema.Type;

export const captureArtifact = (phase: string): Artifact<Capture> => ({
  file: `playground-performance-${phase}.json`,
  producer: `bun --no-env-file apps/cloud/dev/playground/metrics/index.ts ${phase}`,
  schema: captureSchema,
});

const inventorySchema = Schema.Struct({
  scope: Schema.Literal("post-load-paginated-api-identity-inventory"),
  startedAt: Schema.String,
  endedAt: Schema.String,
  api: Schema.String,
  workspace: Schema.String,
  batch: Schema.String,
  count: Schema.Int,
  unique: Schema.Int,
  primaryJournal: Schema.Int,
  missing: Schema.Array(Schema.NullOr(Schema.String)),
  statusMismatches: Schema.Array(
    Schema.Struct({ id: Schema.String, expected: Schema.String, actual: Schema.String }),
  ),
  statuses: Schema.Record(Schema.String, Schema.Int),
  pages: Schema.Array(
    Schema.Struct({
      pageIndex: Schema.Int,
      at: Schema.String,
      items: Schema.Int,
      bytes: Schema.Int,
      status: Schema.Int,
      clientEndToEndMs: Schema.Number,
    }),
  ),
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String,
      status: Schema.String,
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
  limits: Schema.Array(Schema.String),
});

export type PostloadInventory = typeof inventorySchema.Type;

export const postloadInventory: Artifact<PostloadInventory> = {
  file: "playground-performance-postload-inventory.json",
  producer: "bun --no-env-file apps/cloud/dev/playground/metrics/inventory.ts",
  schema: inventorySchema,
};

const segmentsSchema = Schema.Struct({
  scope: Schema.Literal("timestamp-derived-segments-of-preserved-continuous-capture"),
  at: Schema.String,
  firstIntent: Schema.String,
  lastTerminal: Schema.String,
  groups: Schema.Array(
    Schema.Struct({
      group: groupSchema,
      intentAt: Schema.NullOr(Schema.String),
      admittedAt: Schema.NullOr(Schema.String),
      terminalAt: Schema.NullOr(Schema.String),
      admitted: Schema.Int,
      terminal: Schema.Int,
    }),
  ),
  samplerFinalSavedAt: Schema.String,
  segments: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      from: Schema.String,
      to: Schema.String,
      elapsedMs: Schema.Number,
      samples: Schema.Int,
      failures: Schema.Int,
      endToEndMs: distributionSchema,
      endpoints: Schema.Array(endpointSummarySchema),
    }),
  ),
  measurement: Schema.String,
  limits: Schema.Array(Schema.String),
});

export const segmentsArtifact: Artifact<typeof segmentsSchema.Type> = {
  file: "playground-performance-segments.json",
  producer: "bun --no-env-file apps/cloud/dev/playground/metrics/segments.ts",
  schema: segmentsSchema,
};

export const artifactPath = <T>(directory: string, artifact: Artifact<T>) =>
  resolve(directory, artifact.file);

export async function readArtifact<T>(directory: string, artifact: Artifact<T>) {
  const file = Bun.file(artifactPath(directory, artifact));

  if (!(await file.exists())) {
    throw new Error(`Missing ${artifact.file}. Run \`${artifact.producer}\` first.`);
  }

  return decodeBoundary(artifact.schema)(await file.json());
}

export async function writeArtifact<T>(directory: string, artifact: Artifact<T>, value: T) {
  atomic(artifactPath(directory, artifact), encodeBoundary(artifact.schema)(value));
}
