import { Result, Schema } from "effect";
import type { Route, routes } from "./api";
import { boundaryOptions, encodeBoundary } from "./codec";
import { type ErrorBody, errorBodySchema } from "./errors";

export type RouteName = keyof typeof routes;

// A slot is optional when every field in it is optional, so empty params and queries vanish.
type Slot<K extends string, T> = Record<never, never> extends T
  ? { readonly [P in K]?: T }
  : { readonly [P in K]: T };

type BodySlot<T> = undefined extends T ? { readonly body?: undefined } : { readonly body: T };

type Input = {
  readonly params?: Readonly<Record<string, string | number>>;
  readonly query?: object;
  readonly body?: unknown;
};

/** Params and bodies are domain values; query values are the encoded search form. */
export type RouteInput<R extends Route> = Slot<"params", Schema.Schema.Type<R["params"]>> &
  Slot<"query", Schema.Codec.Encoded<R["query"]>> &
  BodySlot<Schema.Schema.Type<R["body"]>> &
  Input;

export type RouteResult<R extends Route> = R["response"]["Type"];

export type RouteRequest = {
  readonly method: Route["method"];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
};

export type RouteOutcome<R extends Route> =
  | { readonly kind: "ok"; readonly value: RouteResult<R> }
  | { readonly kind: "error"; readonly status: number; readonly error: ErrorBody["error"] }
  | { readonly kind: "malformed"; readonly status: number };

/** Every route path is served under this prefix. */
export const API_MOUNT = "/api";

/** The mounted path with captured segments and search values filled in. */
export function routeUrl<R extends Route>(route: R, input: RouteInput<R>): string {
  const path = route.path
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? encodeURIComponent(String(input.params?.[segment.slice(1)]))
        : segment,
    )
    .join("/");

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  return search.size > 0 ? `${API_MOUNT}${path}?${search}` : `${API_MOUNT}${path}`;
}

/** Encodes the body through the route schema, so a value the server would reject never leaves. */
export function routeRequest<R extends Route>(route: R, input: RouteInput<R>): RouteRequest {
  const body =
    input.body === undefined ? undefined : JSON.stringify(encodeBoundary(route.body)(input.body));

  return {
    method: route.method,
    url: routeUrl(route, input),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body,
  };
}

function parse(text: string): Result.Result<unknown, undefined> {
  try {
    return Result.succeed(JSON.parse(text));
  } catch {
    return Result.fail(undefined);
  }
}

/** Decodes a success body by the route schema and any other status by the error contract. */
export function decodeRouteResponse<R extends Route>(
  route: R,
  status: number,
  text: string,
): RouteOutcome<R> {
  const json = parse(text);

  if (Result.isFailure(json)) {
    return { kind: "malformed", status };
  }

  if (status >= 200 && status < 300) {
    const value = Schema.decodeUnknownResult<R["response"]>(
      route.response,
      boundaryOptions,
    )(json.success);

    return Result.isSuccess(value)
      ? { kind: "ok", value: value.success }
      : { kind: "malformed", status };
  }

  const body = Schema.decodeUnknownResult(errorBodySchema, boundaryOptions)(json.success);

  return Result.isSuccess(body)
    ? { kind: "error", status, error: body.success.error }
    : { kind: "malformed", status };
}
