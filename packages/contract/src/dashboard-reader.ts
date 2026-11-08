import type { HookRecord, RunRecord, RunStatus, RuntimeEvent, StorageError } from "@loopy/core";
import type { Effect, Schema } from "effect";
import type { runsQuerySchema } from "./api";
import type {
  EventHistoryPage,
  ExecutionDetail,
  ExecutionPage,
  eventHistoryQuerySchema,
  executionQuerySchema,
  GlobalLogsPage,
  globalLogsQuerySchema,
  logDetailSchema,
  OverviewView,
  overviewQuerySchema,
  ScheduleOverviewView,
  ScopeCountsView,
  ScopeItemsPage,
  scopeItemsQuerySchema,
  statusCountsSchema,
} from "./dashboard";
import type { RunSnapshotView, RunView } from "./views";

export function emptyRunCounts(): Record<RunStatus, number> {
  return { queued: 0, running: 0, suspended: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

export type PendingHook = HookRecord & { expiresAt: string | null };

// A page row whose oversized input or output the store replaced with null, with the real sizes.
export type RunPreview = RunRecord & Pick<RunView, "truncatedFields">;

export type StatusCounts = Schema.Schema.Type<typeof statusCountsSchema>;

export type RunPageQuery = Schema.Schema.Type<typeof runsQuerySchema> & { now: string };

export type OverviewQuery = Schema.Schema.Type<typeof overviewQuerySchema>;

export type NodePageQuery = Schema.Schema.Type<typeof executionQuerySchema>;

export type ScopeItemsQuery = Schema.Schema.Type<typeof scopeItemsQuerySchema>;

export type LogPageQuery = Schema.Schema.Type<typeof globalLogsQuerySchema>;

export type EventPageQuery = Schema.Schema.Type<typeof eventHistoryQuerySchema>;

export type RunDefinitionCount = {
  workspace: string;
  slug: string;
  status: RunStatus;
  count: number;
};

export type DashboardSnapshot = Omit<RunSnapshotView, "run"> & { run: RunPreview };

export interface DashboardReader {
  scheduleOverview(): Effect.Effect<ScheduleOverviewView, StorageError>;
  dashboardSnapshot(id: string): Effect.Effect<DashboardSnapshot | undefined, StorageError>;
  runReference(
    id: string,
  ): Effect.Effect<
    Pick<RunRecord, "id" | "slug" | "workspace" | "revision"> | undefined,
    StorageError
  >;
  runningCount(): Effect.Effect<number, StorageError>;
  queryRuns(query: RunPageQuery): Effect.Effect<RunPreview[], StorageError>;
  runCountsByDefinition(): Effect.Effect<RunDefinitionCount[], StorageError>;
  runWorkspaces(): Effect.Effect<string[], StorageError>;
  pendingHooks(ids: string[], now: string): Effect.Effect<Map<string, PendingHook>, StorageError>;
  overview(query: OverviewQuery): Effect.Effect<OverviewView, StorageError>;
  nodePage(runId: string, query: NodePageQuery): Effect.Effect<ExecutionPage, StorageError>;
  scopeCounts(runId: string, parentScope: string): Effect.Effect<ScopeCountsView[], StorageError>;
  scopeItems(runId: string, query: ScopeItemsQuery): Effect.Effect<ScopeItemsPage, StorageError>;
  execution(
    runId: string,
    key: string,
    after?: number,
  ): Effect.Effect<ExecutionDetail | undefined, StorageError>;
  logPage(query: LogPageQuery): Effect.Effect<GlobalLogsPage, StorageError>;
  logDetail(
    id: number,
  ): Effect.Effect<Schema.Schema.Type<typeof logDetailSchema> | undefined, StorageError>;
  eventPage(query: EventPageQuery): Effect.Effect<EventHistoryPage, StorageError>;
  eventDetail(sequence: number): Effect.Effect<RuntimeEvent | undefined, StorageError>;
}
