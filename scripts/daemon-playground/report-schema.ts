import { Effect, Schema, SchemaGetter } from "effect";
import { boundaryOptions, jsonSchema, routes } from "../../packages/loopy/src/contract/index.ts";

const recordSchema = Schema.Struct({
  slug: Schema.String,
  input: Schema.Struct({
    batch: Schema.String,
    ordinal: Schema.Number,
    fail: Schema.Boolean,
    items: Schema.Array(Schema.Number),
  }),
  run: Schema.Record(Schema.String, jsonSchema).pipe(
    Schema.decodeTo(routes.startRun.response, {
      decode: SchemaGetter.transformEffect((value) =>
        Schema.decodeUnknownEffect(
          routes.startRun.response,
          boundaryOptions,
        )({ ...value, waitingOn: null }).pipe(Effect.mapError((error) => error.issue)),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  ),
  nodeRuns: Schema.Unknown.pipe(
    Schema.decodeTo(routes.run.response.fields.nodeRuns, {
      decode: SchemaGetter.transformEffect((value) =>
        Schema.decodeUnknownEffect(
          routes.run.response.fields.nodeRuns,
          boundaryOptions,
        )(value).pipe(Effect.mapError((error) => error.issue)),
      ),
      encode: SchemaGetter.passthrough(),
    }),
  ),
  receipts: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
      kind: Schema.String,
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
  completed: Schema.Literal(45),
  matched: Schema.Literal(45),
  records: Schema.Array(recordSchema).check(Schema.isBetweenLength(45, 45)),
  restartProof: Schema.Struct({
    runId: Schema.String,
    before: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  }),
});

export type DaemonRunRecord = Schema.Schema.Type<typeof recordSchema>;

export const preflightSchema = Schema.Struct({
  revisions: Schema.Array(Schema.Struct({ slug: Schema.String, revision: Schema.String })),
});
