import type { Effect } from "effect";
import type { ExecutionKey, NodeRun, NodeRunStatus } from "./graph.js";
import type {
  HookRecord,
  LogLevel,
  LogRecord,
  RunRecord,
  RunSnapshot,
  RunStatus,
  RuntimeEvent,
  Schedule,
} from "./model.js";
import type { StorageError } from "./store.js";

export type RunFilter = {
  slug?: string;
  workspace?: string;
  status?: RunStatus;
  from?: string;
  to?: string;
};

export type RunPageQuery = RunFilter & {
  limit: number;
  before?: string;
  waiting?: boolean;
  now: string;
};

export type StatusCounts = Record<RunStatus, number>;

export type RunDefinitionCount = {
  workspace: string;
  slug: string;
  status: RunStatus;
  count: number;
};

export type ScopeCounts = {
  nodeId: string;
  parentScope: ExecutionKey["scope"];
  total: number;
  totalKind?: "materialized";
  counts: Partial<Record<NodeRunStatus, number>>;
};

export type NodePageQuery = {
  scope: string;
  nodeId?: string;
  status?: NodeRunStatus;
  after?: string;
  limit: number;
};

export type NodePage = {
  items: NodeRun[];
  next: string | null;
  truncatedOutputs: Record<string, number>;
};

export type ScopeItemsQuery = {
  nodeId: string;
  parentScope: string;
  after?: number;
  limit: number;
  status?: NodeRunStatus;
};

export type ScopeItem = { index: number; counts: Partial<Record<NodeRunStatus, number>> };

export type FeedQuery = RunFilter & {
  before?: number;
  after?: number;
  limit: number;
  runId?: string;
  nodeId?: string;
};

export type LogPageQuery = FeedQuery & { level?: LogLevel; text?: string; executionKey?: string };

export type EventPageQuery = FeedQuery & {
  entity?: RuntimeEvent["entity"];
  kind?: string;
  txn?: string;
};

export type LogSummary = {
  id: number;
  runId: string;
  slug: string;
  seq: number;
  at: string;
  nodeId: string;
  executionKey: string;
  attempt: number;
  level: LogLevel;
  message: string;
  dataBytes: number;
};

export type EventSummary = {
  sequence: number;
  at: string;
  txn: string;
  runId: string | null;
  slug: string | null;
  nodeId: string | null;
  entity: RuntimeEvent["entity"];
  kind: string;
};

export type FeedPage<T> = {
  items: T[];
  next: number | null;
  scanned: number;
  hasMore: boolean;
  oldest: number | null;
  newest: number | null;
  oldestAt?: string | null;
  newestAt?: string | null;
  scannedToAt?: string | null;
};

export type OverviewQuery = RunFilter & { from: string; to: string; bucketSeconds: number };

export type Overview = {
  from: string;
  to: string;
  bucketSeconds: number;
  counts: StatusCounts;
  buckets: { at: string; counts: StatusCounts }[];
};

export type DashboardSnapshot = RunSnapshot & {
  scopes: ScopeCounts[];
  nodeRunsNext: string | null;
  truncatedOutputs: Record<string, number>;
  hooksTruncated: boolean;
};

export type ScheduleOverview = {
  workspaces: string[];
  active: number;
  next: Pick<Schedule, "workspace" | "slug" | "cron" | "tz" | "nextFireAt">[];
};

export interface DashboardReader {
  scheduleOverview(): Effect.Effect<ScheduleOverview, StorageError>;
  dashboardSnapshot(id: string): Effect.Effect<DashboardSnapshot | undefined, StorageError>;
  runReference(
    id: string,
  ): Effect.Effect<
    Pick<RunRecord, "id" | "slug" | "workspace" | "revision"> | undefined,
    StorageError
  >;
  runningCount(): Effect.Effect<number, StorageError>;
  queryRuns(query: RunPageQuery): Effect.Effect<RunRecord[], StorageError>;
  runCountsByDefinition(): Effect.Effect<RunDefinitionCount[], StorageError>;
  runWorkspaces(): Effect.Effect<string[], StorageError>;
  pendingHooks(
    ids: string[],
    now: string,
  ): Effect.Effect<Map<string, HookRecord & { expiresAt: string | null }>, StorageError>;
  overview(query: OverviewQuery): Effect.Effect<Overview, StorageError>;
  nodePage(runId: string, query: NodePageQuery): Effect.Effect<NodePage, StorageError>;
  scopeCounts(runId: string, parentScope?: string): Effect.Effect<ScopeCounts[], StorageError>;
  scopeItems(
    runId: string,
    query: ScopeItemsQuery,
  ): Effect.Effect<{ items: ScopeItem[]; next: number | null }, StorageError>;
  execution(
    runId: string,
    key: string,
    after?: number,
  ): Effect.Effect<
    | {
        node: NodeRun;
        attempts: NodeRun[];
        attemptsNext: number | null;
        truncatedAttempts: Record<string, number>;
      }
    | undefined,
    StorageError
  >;
  logPage(query: LogPageQuery): Effect.Effect<FeedPage<LogSummary>, StorageError>;
  logDetail(id: number): Effect.Effect<{ id: number; log: LogRecord } | undefined, StorageError>;
  eventPage(query: EventPageQuery): Effect.Effect<FeedPage<EventSummary>, StorageError>;
  eventDetail(sequence: number): Effect.Effect<RuntimeEvent | undefined, StorageError>;
}

export function emptyRunCounts(): StatusCounts {
  return { queued: 0, running: 0, suspended: 0, succeeded: 0, failed: 0, cancelled: 0 };
}
