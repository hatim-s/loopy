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
  scheduleOverview(): Promise<ScheduleOverview>;
  dashboardSnapshot(id: string): Promise<DashboardSnapshot | undefined>;
  runReference(
    id: string,
  ): Promise<Pick<RunRecord, "id" | "slug" | "workspace" | "revision"> | undefined>;
  runningCount(): Promise<number>;
  queryRuns(query: RunPageQuery): Promise<RunRecord[]>;
  runCounts(filter?: RunFilter): Promise<StatusCounts>;
  runWorkspaces(): Promise<string[]>;
  pendingHooks(
    ids: string[],
    now: string,
  ): Promise<Map<string, HookRecord & { expiresAt: string | null }>>;
  overview(query: OverviewQuery): Promise<Overview>;
  nodePage(runId: string, query: NodePageQuery): Promise<NodePage>;
  scopeCounts(runId: string, parentScope?: string): Promise<ScopeCounts[]>;
  scopeItems(
    runId: string,
    query: ScopeItemsQuery,
  ): Promise<{ items: ScopeItem[]; next: number | null }>;
  execution(
    runId: string,
    key: string,
    after?: number,
  ): Promise<
    | {
        node: NodeRun;
        attempts: NodeRun[];
        attemptsNext: number | null;
        truncatedAttempts: Record<string, number>;
      }
    | undefined
  >;
  logPage(query: LogPageQuery): Promise<FeedPage<LogSummary>>;
  logDetail(id: number): Promise<{ id: number; log: LogRecord } | undefined>;
  eventPage(query: EventPageQuery): Promise<FeedPage<EventSummary>>;
  eventDetail(sequence: number): Promise<RuntimeEvent | undefined>;
}

export function emptyRunCounts(): StatusCounts {
  return { queued: 0, running: 0, suspended: 0, succeeded: 0, failed: 0, cancelled: 0 };
}
