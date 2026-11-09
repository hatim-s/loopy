import { Schema } from "effect";
import { counter, positiveInt, struct } from "../codec";
import { executionErrorSchema } from "../executor";
import { jsonSchema } from "../json";
import { executionKeySchema } from "./key";

const RECEIPT_KINDS = ["none", "started", "finished"] as const;

const base = struct({
  key: executionKeySchema,
  attempt: positiveInt,
  maxAttempts: positiveInt,
  startedAt: Schema.String,
  receipt: Schema.Literals(RECEIPT_KINDS),
  inputView: Schema.optional(
    Schema.Union([
      struct({ state: Schema.Literal("available"), value: jsonSchema }),
      struct({ state: Schema.Literal("truncated"), bytes: counter }),
    ]),
  ),
});

export const nodeRunSchema = Schema.Union([
  struct({ ...base.fields, status: Schema.Literal("running") }),
  struct({
    ...base.fields,
    status: Schema.Literal("succeeded"),
    output: jsonSchema,
    endedAt: Schema.String,
  }),
  struct({
    ...base.fields,
    status: Schema.Literal("failed"),
    error: executionErrorSchema,
    endedAt: Schema.String,
  }),
  struct({
    ...base.fields,
    status: Schema.Literal("retrying"),
    error: executionErrorSchema,
    nextRetryAt: Schema.String,
    endedAt: Schema.String,
  }),
  struct({
    ...base.fields,
    status: Schema.Literal("waiting"),
    wakeAt: Schema.NullOr(Schema.String),
  }),
  struct({ ...base.fields, status: Schema.Literal("sleeping"), wakeAt: Schema.String }),
  struct({ ...base.fields, status: Schema.Literal("cancelled"), endedAt: Schema.String }),
  struct({ ...base.fields, status: Schema.Literal("queued") }),
  struct({ ...base.fields, status: Schema.Literal("skipped"), endedAt: Schema.String }),
  struct({ ...base.fields, status: Schema.Literal("rate_limited"), nextRetryAt: Schema.String }),
]);

export type NodeRun = Schema.Schema.Type<typeof nodeRunSchema>;

export type NodeRunStatus = NodeRun["status"];

export const NODE_RUN_STATUSES = nodeRunSchema.members.map(
  (member) => member.fields.status.schema.literal,
);
