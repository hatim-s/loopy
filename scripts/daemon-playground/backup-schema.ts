import { Schema } from "effect";
import { runStatusSchema } from "../../packages/loopy/src/contract";

const rows = Schema.Array(Schema.Struct({ id: Schema.String, status: runStatusSchema }));

const sidecars = Schema.Array(
  Schema.Struct({
    suffix: Schema.String,
    bytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

export const backupSchema = Schema.Struct({
  method: Schema.String,
  source: Schema.String,
  destination: Schema.String,
  destinationJournal: Schema.Literal("delete"),
  sidecarsBefore: sidecars,
  sidecarsAfter: sidecars,
  sourceRows: rows,
  copiedRows: rows,
  integrity: Schema.String,
  matchesSource: Schema.Boolean,
  matchesApi: Schema.NullOr(Schema.Boolean),
  matches45ApiRuns: Schema.Boolean,
});
