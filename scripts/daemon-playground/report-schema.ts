import { z } from "zod";
import { jsonSchema, routes } from "../../packages/loopy/src/contract/index.ts";

const recordSchema = z.object({
  slug: z.string(),
  input: z.object({
    batch: z.string(),
    ordinal: z.number(),
    fail: z.boolean(),
    items: z.array(z.number()),
  }),
  run: z
    .record(z.string(), jsonSchema)
    .transform((value) => routes.startRun.response.parse({ ...value, waitingOn: null })),
  nodeRuns: routes.run.response.shape.nodeRuns,
  receipts: z.array(
    z.object({ path: z.string(), sha256: z.string(), kind: z.string(), attempt: z.number() }),
  ),
  outputs: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })),
  outputDirectory: z.string(),
  observedMs: z.number(),
  admissionMs: z.number(),
  firstNodeStartedAt: z.string().nullable(),
  hold: z.object({ heldMs: z.number(), approved: z.boolean() }).nullable(),
  matched: z.literal(true),
});

export const reportSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string(),
  completed: z.literal(45),
  matched: z.literal(45),
  records: z.array(recordSchema).length(45),
  restartProof: z.object({
    runId: z.string(),
    before: z.array(z.object({ path: z.string(), sha256: z.string() })),
  }),
});

export type DaemonRunRecord = z.infer<typeof recordSchema>;

export const preflightSchema = z.object({
  revisions: z.array(z.object({ slug: z.string(), revision: z.string() })),
});
