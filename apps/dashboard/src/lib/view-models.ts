import type {
  ExecutionDetail,
  LogRecord,
  LogSummaryView,
  LoopyView,
  NodeRunView,
  RunStatus,
  RunView,
  ScopeItemsPage,
  ServerEvent,
  SourceArtifact,
} from "@loopy/contract";
import type { Period } from "./period";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "error"; error: Error }
  | { state: "ready"; data: T; fetching: boolean };

export type Lazy<T> = Loaded<T> | { state: "idle" };

export type Page<Row> = {
  rows: Row[];
  /** Zero-based position of the first row in the filtered list, for "51 to 100". */
  offset: number;
  hasNext: boolean;
  hasPrevious: boolean;
};

export type Pager<Row, Extra = object> = Loaded<Page<Row> & Extra> & {
  next: () => void;
  previous: () => void;
  first: () => void;
};

export type StatusCounts = Record<RunStatus, number>;

export type LoopyRow = LoopyView & { latestRuns: RunView[] };

export type RunListFilters = {
  slug?: string;
  workspace?: string;
  status?: RunStatus;
  waiting?: boolean;
  /** Only runs created inside this window. Absent means every retained run. */
  period?: Period;
};

export type ScopeTuple = NodeRunView["key"]["scope"];

export type ScopeItemRow = ScopeItemsPage["items"][number];

export type ScopeItemQuery = {
  nodeId: string;
  parentScope: ScopeTuple;
  status?: NodeRunView["status"];
};

export type ExecutionRow = {
  execution: NodeRunView;
  truncatedOutputBytes: number | null;
};

export type ExecutionScope = { scope: ScopeTuple; nodeId?: string };

/** `attemptsIncomplete`: earlier attempts exist beyond the cap or before attempts were stored. */
export type ExecutionView = ExecutionDetail & { attemptsIncomplete: boolean };

export type SourceFile = Extract<SourceArtifact, { status: "available" }>["files"][number];

export type SourceRange = Extract<SourceArtifact, { status: "available" }>["ranges"][number];

export const LOG_LEVELS = ["info", "warn", "error"] as const satisfies LogRecord["level"][];

export type LogRow = Omit<LogSummaryView, "nodeId" | "executionKey" | "dataBytes"> & {
  nodeId: string | null;
  executionKey: string | null;
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
};

export type EventEntity = ServerEvent["entity"];

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
