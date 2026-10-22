import type {
  DaemonView,
  EventSummaryView,
  Json,
  LogRecord,
  LoopyView,
  NodeRunView,
  RunStatus,
  RunView,
  ScopeCountsView,
  ScopeItemsPage,
  ServerEvent,
  SourceArtifact,
} from "loopy/contract";

export const PERIODS = ["1h", "24h", "7d", "30d"] as const;

export type Period = (typeof PERIODS)[number];

/** One fetch as a screen sees it. `fetching` is true while a refetch runs behind shown data. */
export type Loaded<T> =
  | { state: "loading" }
  | { state: "error"; error: Error }
  | { state: "ready"; data: T; fetching: boolean };

/** A requested-on-open fetch that nothing asked for yet. */
export type Lazy<T> = Loaded<T> | { state: "idle" };

/** One keyset page. Rows are only this page; earlier pages are not held for rendering. */
export type Page<Row> = {
  rows: Row[];
  /** Zero-based position of the first row in the filtered list, for "51 to 100". */
  offset: number;
  hasNext: boolean;
  hasPrevious: boolean;
};

/** A paged list. `next` and `previous` move one page; `first` returns to the newest page. */
export type Pager<Row, Extra = object> = Loaded<Page<Row> & Extra> & {
  next: () => void;
  previous: () => void;
  first: () => void;
};

export type StatusCounts = Record<RunStatus, number>;

export type OverviewBucket = { start: string; counts: StatusCounts };

/** Run totals for a window, from GET /overview. `previous` is the window before it. */
export type OverviewView = {
  period: Period;
  from: string;
  to: string;
  bucketSeconds: number;
  totals: StatusCounts;
  previous: StatusCounts | null;
  buckets: OverviewBucket[];
};

/** A saved loopy with its newest runs, newest first, at most ten. */
export type LoopyRow = LoopyView & { latestRuns: RunView[] };

export type RunListFilters = {
  slug?: string;
  workspace?: string;
  status?: RunStatus;
  /** Suspended runs held on a hook. */
  waiting?: boolean;
  /** Only runs created inside this window. Absent means every retained run. */
  period?: Period;
};

export type ScopeTuple = NodeRunView["key"]["scope"];

/** Grouped counts for one map node inside one parent scope, from the slim run snapshot. */
export type ScopeSummary = ScopeCountsView;

export type ScopeItemRow = ScopeItemsPage["items"][number];

export type ScopeItemQuery = {
  nodeId: string;
  parentScope: ScopeTuple;
  status?: NodeRunView["status"];
};

/** An execution row. A large output arrives as null with its size; open the detail for it. */
export type ExecutionRow = {
  execution: NodeRunView;
  truncatedOutputBytes: number | null;
};

export type ExecutionQuery = { scope: ScopeTuple; nodeId?: string };

export type AttemptRow = {
  attempt: number;
  status: NodeRunView["status"];
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
};

/** What an execution read, when the daemon recorded it. */
export type RecordedInput =
  | { state: "recorded"; value: Json }
  | { state: "not_recorded" }
  | Extract<NodeRunView["inputView"], { state: "truncated" }>;

/** One execution opened in full, from GET /runs/:id/execution. */
export type ExecutionDetail = {
  execution: NodeRunView;
  input: RecordedInput;
  attempts: AttemptRow[];
  /** Earlier attempts exist beyond the cap or before attempts were stored. */
  attemptsIncomplete: boolean;
};

export type SourceView = SourceArtifact;

export type SourceFile = Extract<SourceArtifact, { status: "available" }>["files"][number];

export type SourceRange = Extract<SourceArtifact, { status: "available" }>["ranges"][number];

export const LOG_LEVELS = ["info", "warn", "error"] as const satisfies LogRecord["level"][];

/** A log line in a list. Data loads with useLog when the row opens. */
export type LogRow = {
  id: number;
  runId: string;
  slug: string;
  nodeId: string | null;
  executionKey: string | null;
  attempt: number | null;
  level: LogRecord["level"];
  message: string;
  at: string;
  hasData: boolean;
};

export type LogFilters = {
  /** Absent means every retained log, including executions older than the preset windows. */
  period?: Period;
  slug?: string;
  runId?: string;
  nodeId?: string;
  executionKey?: string;
  status?: RunStatus;
  level?: LogRecord["level"];
  text?: string;
  /** Keep the newest page current while it is the page shown. */
  tail: boolean;
};

/**
 * How far a filtered scan reached. Selective filters stop after a bounded scan, so an empty
 * page can still have older pages, and the screen says where the search stopped.
 */
export type ScanInfo = {
  searchedBackTo: string | null;
  retained: { oldest: string; newest: string } | null;
  /** Newer rows that arrived while the newest page was not followed. */
  newer: number | null;
};

export type EventEntity = ServerEvent["entity"];

/** An outbox row without its record. useEvent loads the record. */
export type EventRow = EventSummaryView;

export type EventFilters = {
  period: Period;
  status?: RunStatus;
  slug?: string;
  runId?: string;
  nodeId?: string;
  entity?: EventEntity;
  kind?: string;
  txn?: string;
};

export type DaemonSlot = { runId: string; slug: string; since: string };

/** `slots` is null until the daemon reports which run holds each slot. */
export type DaemonDetail = DaemonView & { slots: DaemonSlot[] | null };
