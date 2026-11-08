import { runStatusSchema } from "@loopy/contract";
import { Schema } from "effect";
import { PLANNED_RUNS } from "./plan";

// Analysis reads only these fields; node runs come from the verified closed backup instead.
const recordSchema = Schema.Struct({
  slug: Schema.String,
  input: Schema.Struct({
    batch: Schema.String,
    ordinal: Schema.Number,
    fail: Schema.Boolean,
    items: Schema.Array(Schema.Number),
  }),
  run: Schema.Struct({
    id: Schema.String,
    status: runStatusSchema,
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
  receipts: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
      kind: Schema.Literals(["started", "finished"]),
      attempt: Schema.Number,
    }),
  ),
  outputs: Schema.Array(
    Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Schema.String }),
  ),
  outputDirectory: Schema.String,
  observedMs: Schema.Number,
  admissionMs: Schema.Number,
  firstNodeStartedAt: Schema.NullOr(Schema.String),
  hold: Schema.NullOr(Schema.Struct({ heldMs: Schema.Number, approved: Schema.Boolean })),
  matched: Schema.Literal(true),
});

export const reportSchema = Schema.Struct({
  startedAt: Schema.String,
  endedAt: Schema.String,
  completed: Schema.Literal(PLANNED_RUNS),
  matched: Schema.Literal(PLANNED_RUNS),
  records: Schema.Array(recordSchema).check(Schema.isBetweenLength(PLANNED_RUNS, PLANNED_RUNS)),
  restartProof: Schema.Struct({
    runId: Schema.String,
    before: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  }),
});

export type DaemonRunRecord = typeof recordSchema.Type;

export const preflightSchema = Schema.Struct({
  revisions: Schema.Array(Schema.Struct({ slug: Schema.String, revision: Schema.String })),
});
