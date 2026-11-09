import {
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  type RouteInput,
  type RouteName,
  type RouteResult,
  type routes,
  type ServerEvent,
} from "@loopy/contract";

export type ApiInput<K extends RouteName> = RouteInput<(typeof routes)[K]>;

export type ApiResult<K extends RouteName> = RouteResult<(typeof routes)[K]>;

export type ApiQuery<K extends RouteName> = NonNullable<ApiInput<K>["query"]>;

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

/** The one seam between the UI and the daemon. Components never call fetch. */
export type LoopyBackend = {
  call<K extends RouteName>(
    name: K,
    input: ApiInput<K>,
    signal?: AbortSignal,
  ): Promise<ApiResult<K>>;
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
