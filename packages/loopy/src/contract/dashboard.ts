import { z } from "zod";
import { LOG_LEVELS, NODE_RUN_STATUSES } from "../core/index.js";
import { executionKeySchema, nodeRunViewSchema } from "./graph.js";
import { logRecordSchema, runStatusSchema } from "./records.js";

const iso = z.iso.datetime({ precision: 3 });

const limit = z.coerce.number().int().positive().max(200).default(50);

const numericCursor = z.coerce.number().int().nonnegative().optional();

export const runFilterFields = {
  slug: z.string().optional(),
  workspace: z.string().optional(),
  status: runStatusSchema.optional(),
  from: iso.optional(),
  to: iso.optional(),
};

export const statusCountsSchema = z.record(runStatusSchema, z.number().int().nonnegative());

export const nodeCountsSchema = z.partialRecord(
  z.enum(NODE_RUN_STATUSES),
  z.number().int().nonnegative(),
);

export const scopeCountsSchema = z.strictObject({
  nodeId: z.string(),
  parentScope: executionKeySchema.shape.scope,
  total: z.number().int().nonnegative(),
  totalKind: z.literal("materialized").optional(),
  counts: nodeCountsSchema,
});

const scope = z
  .string()
  .default("[]")
  .refine((value) => {
    try {
      return executionKeySchema.shape.scope.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  }, "Scope must be a JSON array of {nodeId,index} tuples.")
  .transform((value) => JSON.stringify(executionKeySchema.shape.scope.parse(JSON.parse(value))));

export const executionQuerySchema = z.strictObject({
  scope,
  nodeId: z.string().optional(),
  status: z.enum(NODE_RUN_STATUSES).optional(),
  after: z.string().optional(),
  limit,
});

export const executionDetailQuerySchema = z.strictObject({
  key: z.string(),
  attemptsAfter: numericCursor,
});

export const executionPageSchema = z.strictObject({
  items: z.array(nodeRunViewSchema),
  next: z.string().nullable(),
  truncatedOutputs: z.record(z.string(), z.number().int().nonnegative()),
});

export const executionDetailSchema = z.strictObject({
  node: nodeRunViewSchema,
  attempts: z.array(nodeRunViewSchema),
  attemptsNext: z.number().int().positive().nullable(),
  truncatedAttempts: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

export const scopeItemsQuerySchema = z.strictObject({
  nodeId: z.string(),
  parentScope: scope,
  after: numericCursor,
  limit,
  status: z.enum(NODE_RUN_STATUSES).optional(),
});

export const scopeItemsPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({ index: z.number().int().nonnegative(), counts: nodeCountsSchema }),
  ),
  next: z.number().int().nonnegative().nullable(),
});

export const overviewQuerySchema = z
  .strictObject({
    ...runFilterFields,
    from: iso,
    to: iso,
    bucketSeconds: z.coerce.number().int().min(60).default(3600),
  })
  .refine(
    (query) =>
      Date.parse(query.to) > Date.parse(query.from) &&
      Math.ceil((Date.parse(query.to) - Date.parse(query.from)) / (query.bucketSeconds * 1000)) <=
        744,
    "Window must contain between 1 and 744 buckets.",
  );

export const overviewSchema = z.strictObject({
  from: iso,
  to: iso,
  bucketSeconds: z.number(),
  counts: statusCountsSchema,
  buckets: z.array(z.strictObject({ at: iso, counts: statusCountsSchema })),
});

const feedFilterFields = {
  ...runFilterFields,
  before: numericCursor,
  after: numericCursor,
  limit,
  runId: z.string().optional(),
  nodeId: z.string().optional(),
};

export const globalLogsQuerySchema = z
  .strictObject({
    ...feedFilterFields,
    level: z.enum(LOG_LEVELS).optional(),
    text: z.string().max(256).optional(),
    executionKey: z.string().optional(),
  })
  .refine(
    (query) => query.before === undefined || query.after === undefined,
    "Use before or after, not both.",
  );

export const eventHistoryQuerySchema = z
  .strictObject({
    ...feedFilterFields,
    entity: z.enum(["run", "node", "step", "log", "hook", "schedule"]).optional(),
    kind: z.string().optional(),
    txn: z.string().optional(),
  })
  .refine(
    (query) => query.before === undefined || query.after === undefined,
    "Use before or after, not both.",
  );

export const logSummarySchema = z.strictObject({
  id: z.number().int().positive(),
  runId: z.string(),
  slug: z.string(),
  seq: z.number().int().positive(),
  at: z.string(),
  nodeId: z.string(),
  executionKey: z.string(),
  attempt: z.number().int().positive(),
  level: z.enum(LOG_LEVELS),
  message: z.string(),
  dataBytes: z.number().int().nonnegative(),
});

export const eventSummarySchema = z.strictObject({
  sequence: z.number().int().positive(),
  at: z.string(),
  txn: z.string(),
  runId: z.string().nullable(),
  slug: z.string().nullable(),
  nodeId: z.string().nullable(),
  entity: z.enum(["run", "node", "step", "log", "hook", "schedule"]),
  kind: z.string(),
});

const feedCursorFields = {
  oldestAt: z.string().nullable().optional(),
  newestAt: z.string().nullable().optional(),
  scannedToAt: z.string().nullable().optional(),
  next: z.number().int().nonnegative().nullable(),
  scanned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  oldest: z.number().int().nullable(),
  newest: z.number().int().nullable(),
};

export const globalLogsPageSchema = z.strictObject({
  ...feedCursorFields,
  items: z.array(logSummarySchema),
});

export const eventHistoryPageSchema = z.strictObject({
  ...feedCursorFields,
  items: z.array(eventSummarySchema),
});

export const logDetailSchema = z.strictObject({
  id: z.number().int().positive(),
  log: logRecordSchema,
});

export type OverviewView = z.infer<typeof overviewSchema>;

export type ScopeCountsView = z.infer<typeof scopeCountsSchema>;

export type ExecutionPage = z.infer<typeof executionPageSchema>;

export type ExecutionDetail = z.infer<typeof executionDetailSchema>;

export type ScopeItemsPage = z.infer<typeof scopeItemsPageSchema>;

export type GlobalLogsPage = z.infer<typeof globalLogsPageSchema>;

export type EventHistoryPage = z.infer<typeof eventHistoryPageSchema>;

export type LogSummaryView = z.infer<typeof logSummarySchema>;

export type EventSummaryView = z.infer<typeof eventSummarySchema>;

export const scheduleSummarySchema = z.strictObject({
  workspace: z.string(),
  slug: z.string(),
  cron: z.string(),
  tz: z.string(),
  nextFireAt: iso,
});

export const scheduleOverviewSchema = z.strictObject({
  workspaces: z.array(z.string()),
  active: z.number().int().nonnegative(),
  next: z.array(scheduleSummarySchema).max(10),
});

export type ScheduleOverviewView = z.infer<typeof scheduleOverviewSchema>;

export const scopesQuerySchema = z.strictObject({ parentScope: scope });
