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
  type routes,
  type ScheduleView,
  type ServerEvent,
} from "loopy/contract";

import type { z } from "zod";

type ApiQuery<K extends keyof typeof routes> = z.input<(typeof routes)[K]["query"]>;

type ApiResult<K extends keyof typeof routes> = z.output<(typeof routes)[K]["response"]>;

export type OverviewQuery = ApiQuery<"overview">;

export type ExecutionQuery = ApiQuery<"executions">;

export type ScopeItemsQuery = ApiQuery<"scopeItems">;

export type GlobalLogsQuery = ApiQuery<"globalLogs">;

export type EventHistoryQuery = ApiQuery<"eventHistory">;

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
  loopies(workspace?: string): Promise<LoopyView[]>;
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
  scheduleOverview(signal?: AbortSignal): Promise<ApiResult<"scheduleOverview">>;
  schedules(workspace: string): Promise<ScheduleView[]>;
  putSchedule(slug: string, workspace: string, body: PutScheduleBody): Promise<ScheduleView>;
  setScheduleEnabled(slug: string, workspace: string, enabled: boolean): Promise<ScheduleView>;
  deleteSchedule(slug: string, workspace: string): Promise<{ deleted: true }>;
  overview(query: OverviewQuery, signal?: AbortSignal): Promise<ApiResult<"overview">>;
  source(slug: string, workspace: string, signal?: AbortSignal): Promise<ApiResult<"source">>;
  runSource(id: string, signal?: AbortSignal): Promise<ApiResult<"runSource">>;
  runPayload(id: string, signal?: AbortSignal): Promise<ApiResult<"runPayload">>;
  scopes(id: string, query: ApiQuery<"scopes">, signal?: AbortSignal): Promise<ApiResult<"scopes">>;
  executions(
    id: string,
    query: ExecutionQuery,
    signal?: AbortSignal,
  ): Promise<ApiResult<"executions">>;
  execution(
    id: string,
    query: ApiQuery<"execution">,
    signal?: AbortSignal,
  ): Promise<ApiResult<"execution">>;
  scopeItems(
    id: string,
    query: ScopeItemsQuery,
    signal?: AbortSignal,
  ): Promise<ApiResult<"scopeItems">>;
  globalLogs(query: GlobalLogsQuery, signal?: AbortSignal): Promise<ApiResult<"globalLogs">>;
  log(id: number, signal?: AbortSignal): Promise<ApiResult<"log">>;
  eventHistory(query: EventHistoryQuery, signal?: AbortSignal): Promise<ApiResult<"eventHistory">>;
  event(sequence: number, signal?: AbortSignal): Promise<ApiResult<"event">>;
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
