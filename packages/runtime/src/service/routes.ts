import {
  type DaemonView,
  DEFAULT_ERROR_MESSAGES,
  decodeBoundary,
  type ErrorCode,
  encodeBoundary,
  routes,
} from "@loopy/contract";
import type { Store } from "@loopy/core";
import { Cause, Effect, Exit, Schema } from "effect";
import { ServiceError } from "./error";
import type { EventReader } from "./events";
import { eventStream } from "./events";
import { SecretError } from "./registry";
import type { Service } from "./service";

const STATUS: Record<ErrorCode, number> = {
  not_yet: 501,
  not_found: 404,
  unknown_hook: 404,
  not_claimable: 409,
  conflict: 409,
  owned_elsewhere: 409,
  bad_request: 400,
  invalid_schedule: 400,
  stale_cursor: 410,
  unauthorized: 401,
  forbidden: 403,
  internal: 500,
  invalid_cron: 400,
  invalid_timezone: 400,
};

// BOUNDARY: Route schemas validate response data before JSON serialization.
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function errorResponse(code: ErrorCode, message = DEFAULT_ERROR_MESSAGES[code]): Response {
  return json({ error: { code, message } }, STATUS[code]);
}

export type RouteDependencies = {
  service: Service;
  onError?: (cause: Cause.Cause<unknown>) => void;
  store: Pick<Store, "getLogs" | "runningCount" | "nextWakeAt"> & EventReader;
  cwd: string;
  daemon: Pick<DaemonView, "pid" | "startedAt" | "concurrency">;
};

type Schemas<P, Q, B, R> = {
  method: string;
  path: string;
  params: Schema.Codec<P, unknown>;
  query: Schema.Codec<Q, unknown>;
  body: Schema.Codec<B, unknown>;
  response: Schema.Codec<R, unknown>;
};

function makeEndpoint<P, Q, B, R, E>(
  route: Schemas<P, Q, B, R>,
  handle: (context: {
    params: P;
    query: Q;
    body: B;
    request: Request;
  }) => Effect.Effect<R | Response, E>,
  onError?: RouteDependencies["onError"],
) {
  const encode = encodeBoundary(route.response);

  return {
    ...route,
    async handle(params: Record<string, string>, request: Request, url: URL) {
      const exit = await Effect.runPromiseExit(
        parseRequest(route, params, request, url).pipe(
          Effect.flatMap((parsed) => handle({ ...parsed, request })),
          Effect.map((result) => (result instanceof Response ? result : json(encode(result)))),
        ),
      );

      if (Exit.isFailure(exit)) {
        const reasons = exit.cause.reasons;

        if (reasons.length === 1 && reasons[0] && Cause.isFailReason(reasons[0])) {
          const error = reasons[0].error;

          if (error instanceof ServiceError) {
            return errorResponse(error.code, error.message);
          }

          if (error instanceof SecretError && error.reason === "invalid") {
            return errorResponse("bad_request");
          }
        }

        onError?.(exit.cause);

        return errorResponse("internal");
      }

      return exit.value;
    },
  };
}

// BOUNDARY: URL captures, search values and JSON enter the contract here.
const parseRequest = Effect.fn("Http.decodeRequest")(function* <P, Q, B>(
  route: Omit<Schemas<P, Q, B, unknown>, "method" | "response">,
  params: Record<string, string>,
  request: Request,
  url: URL,
) {
  const query = Object.fromEntries(url.searchParams);

  if (route.path === routes.events.path) {
    const last = request.headers.get("Last-Event-ID");

    if (last !== null) {
      query.after = last;
    }
  }

  const body: unknown =
    ["POST", "PUT"].includes(request.method) && request.body
      ? yield* Effect.tryPromise({ try: () => request.json(), catch: (cause) => cause }).pipe(
          Effect.catch((error) =>
            error instanceof SyntaxError
              ? Effect.fail(new ServiceError("bad_request"))
              : Effect.die(error),
          ),
        )
      : undefined;

  return yield* Effect.try({
    try: () => ({
      params: decodeBoundary(route.params)(params),
      query: decodeBoundary(route.query)(query),
      body: decodeBoundary(route.body)(body),
    }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Schema.isSchemaError(error)
        ? Effect.fail(new ServiceError("bad_request"))
        : Effect.die(error),
    ),
  );
});

export function apiRoutes({ service, store, cwd, daemon, onError }: RouteDependencies) {
  const endpoint: typeof makeEndpoint = (route, handle) => makeEndpoint(route, handle, onError);

  return [
    endpoint(routes.scheduleOverview, () => service.scheduleOverview()),
    endpoint(routes.secrets, () => service.listSecrets()),
    endpoint(routes.putSecret, ({ params, body }) => service.putSecret(params.name, body.value)),
    endpoint(routes.deleteSecret, ({ params }) => service.deleteSecret(params.name)),
    endpoint(routes.generateTypes, ({ body }) => service.generateTypes(body)),
    endpoint(routes.resolveNamedHook, ({ params, body }) =>
      service.resolveNamedHook(params.id, params.name, body.payload),
    ),
    endpoint(routes.putLoopy, ({ params: { slug }, body }) => service.putLoopy(slug, body)),
    endpoint(routes.graph, ({ params: { slug }, query }) =>
      service.graph(slug, query.workspace ?? cwd),
    ),
    endpoint(routes.runGraph, ({ params: { id } }) => service.runGraph(id)),
    endpoint(routes.source, ({ params: { slug }, query }) =>
      service.loopySource(slug, query.workspace ?? cwd),
    ),
    endpoint(routes.runSource, ({ params: { id } }) => service.runSource(id)),
    endpoint(routes.overview, ({ query }) => service.overview(query)),
    endpoint(routes.executions, ({ params: { id }, query }) => service.executions(id, query)),
    endpoint(routes.execution, ({ params: { id }, query }) => service.execution(id, query)),
    endpoint(routes.scopes, ({ params: { id }, query }) => service.scopes(id, query)),
    endpoint(routes.runPayload, ({ params: { id } }) => service.runPayload(id)),
    endpoint(routes.scopeItems, ({ params: { id }, query }) => service.scopeItems(id, query)),
    endpoint(routes.globalLogs, ({ query }) => service.globalLogs(query)),
    endpoint(routes.log, ({ params: { id } }) => service.log(id)),
    endpoint(routes.eventHistory, ({ query }) => service.eventHistory(query)),
    endpoint(routes.event, ({ params: { sequence } }) => service.event(sequence)),
    endpoint(routes.schedules, ({ query }) => service.listSchedules(query.workspace)),
    endpoint(routes.putSchedule, ({ params: { slug }, body, query }) =>
      service.putSchedule(slug, body, query.workspace),
    ),
    endpoint(routes.setScheduleEnabled, ({ params: { slug }, body, query }) =>
      service.setScheduleEnabled(slug, body.enabled, query.workspace),
    ),
    endpoint(routes.deleteSchedule, ({ params: { slug }, query }) =>
      service.deleteSchedule(slug, query.workspace),
    ),
    endpoint(routes.loopies, ({ query }) => service.listLoopies(query.workspace)),
    endpoint(routes.runs, ({ query }) => service.listRuns(query)),
    endpoint(routes.run, ({ params: { id } }) => service.runSnapshot(id)),
    endpoint(routes.logs, ({ params: { id }, query }) =>
      service.logs(id, query.after, query.limit),
    ),
    endpoint(routes.startRun, ({ params: { slug }, body }) =>
      service.startRun(slug, body.input, body.workspace ?? cwd),
    ),
    endpoint(routes.resumeRun, ({ params: { id } }) => service.resumeRun(id)),
    endpoint(routes.cancelRun, ({ params: { id } }) => service.cancelRun(id)),
    endpoint(routes.resolveHook, ({ params: { token }, body }) =>
      service.resolveHook(token, body.payload),
    ),
    endpoint(routes.daemon, () =>
      Effect.gen(function* () {
        return {
          pid: daemon.pid,
          startedAt: daemon.startedAt,
          concurrency: daemon.concurrency,
          running: yield* store.runningCount(),
          nextWakeAt: (yield* store.nextWakeAt()) ?? null,
        };
      }),
    ),
    endpoint(routes.events, ({ query, request }) =>
      eventStream(store, service, query, request.signal),
    ),
    endpoint(routes.cursor, () => service.cursor()),
  ];
}

function match(pattern: string, path: string): Record<string, string> | undefined {
  const expected = pattern.split("/");
  const actual = path.slice("/api".length).split("/");

  if (expected.length !== actual.length) {
    return undefined;
  }

  const pairs: [string, string][] = [];

  for (const [index, part] of expected.entries()) {
    const value = actual[index];

    if (value === undefined) {
      return undefined;
    }

    if (part.startsWith(":")) {
      pairs.push([part.slice(1), value]);
    } else if (part !== value) {
      return undefined;
    }
  }

  return Object.fromEntries(pairs);
}

export async function dispatch(table: ReturnType<typeof apiRoutes>, request: Request, url: URL) {
  try {
    const path = decodeURIComponent(url.pathname);

    for (const route of table) {
      const params = match(route.path, path);

      if (route.method === request.method && params) {
        return await route.handle(params, request, url);
      }
    }

    throw new ServiceError("not_found");
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResponse(error.code, error.message);
    }

    throw error;
  }
}
