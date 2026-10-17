import {
  type DaemonView,
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  type Json,
  type LogRecord,
  type LoopyView,
  type RunSnapshotView,
  type RunView,
  type runsQuerySchema,
  type ServerEvent,
} from "loopy/contract";
import type { z } from "zod";

export type RunsQuery = z.output<typeof runsQuerySchema>;

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
  loopies(): Promise<LoopyView[]>;
  runs(query: RunsQuery): Promise<RunView[]>;
  run(id: string, signal?: AbortSignal): Promise<RunSnapshotView>;
  logs(id: string, after: number): Promise<LogRecord[]>;
  startRun(slug: string, input: Json): Promise<RunView>;
  resumeRun(id: string): Promise<RunView>;
  cancelRun(id: string): Promise<RunView>;
  resolveHook(token: string, payload: Json): Promise<RunView>;
  daemon(): Promise<DaemonView>;
  events(subscription: EventSubscription): Promise<StreamEnd>;
};

const CLIENT_ERROR_MESSAGES = {
  unauthorized: "The session token is missing or expired. Open the URL printed by loopy ui.",
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
