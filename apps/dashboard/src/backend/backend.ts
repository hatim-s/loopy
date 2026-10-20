import {
  type CursorView,
  type DaemonView,
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  type GraphRevisionView,
  type Json,
  type LogRecord,
  type LoopyView,
  type PutScheduleBody,
  type RunSnapshotView,
  type RunsQuery,
  type RunView,
  type ScheduleView,
  type ServerEvent,
} from "loopy/contract";

export type { RunsQuery } from "loopy/contract";

/** live: frames arrive. reconnecting: the transport is retrying. stale: it gave up. */
export type StreamState = "connecting" | "live" | "reconnecting" | "stale";

export type EventSubscription = {
  after: number;
  epoch: string;
  signal: AbortSignal;
  onBatch: (batch: ServerEvent[]) => void;
  onState: (state: StreamState) => void;
};

/**
 * Why a subscription ended: the caller aborted it, or the backend no longer holds the
 * cursor or epoch and the caller must refetch before subscribing again.
 */
export type StreamEnd = "aborted" | "reset";

/** The one seam between the UI and wherever runs live. Components never call fetch. */
export type LoopyBackend = {
  cursor(signal: AbortSignal): Promise<CursorView>;
  loopies(): Promise<LoopyView[]>;
  /** The latest revision saved in `workspace`, which the next run there will pin. */
  loopyGraph(slug: string, workspace: string): Promise<GraphRevisionView>;
  runs(query: RunsQuery): Promise<RunView[]>;
  run(id: string, signal: AbortSignal): Promise<RunSnapshotView>;
  /** The revision the run pinned when it was created, never the latest save. */
  runGraph(id: string): Promise<GraphRevisionView>;
  logs(id: string, after: number): Promise<LogRecord[]>;
  startRun(slug: string, input: Json, workspace: string): Promise<RunView>;
  resumeRun(id: string): Promise<RunView>;
  cancelRun(id: string): Promise<RunView>;
  resolveHook(token: string, payload: Json): Promise<RunView>;
  daemon(): Promise<DaemonView>;
  schedules(): Promise<ScheduleView[]>;
  putSchedule(slug: string, body: PutScheduleBody): Promise<ScheduleView>;
  setScheduleEnabled(slug: string, enabled: boolean): Promise<ScheduleView>;
  deleteSchedule(slug: string): Promise<{ deleted: true }>;
  events(subscription: EventSubscription): Promise<StreamEnd>;
};

const CLIENT_ERROR_MESSAGES = {
  unreachable: "The Loopy server did not answer. Check that the daemon is running.",
  malformed_response: "The server sent a response this dashboard does not understand.",
} as const;

export type BackendErrorCode = ErrorCode | keyof typeof CLIENT_ERROR_MESSAGES;

const MESSAGES = {
  ...DEFAULT_ERROR_MESSAGES,
  ...CLIENT_ERROR_MESSAGES,
} satisfies Record<BackendErrorCode, string>;

export class BackendError extends Error {
  readonly code: BackendErrorCode;

  constructor(code: BackendErrorCode, message: string = MESSAGES[code]) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}
