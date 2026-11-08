import {
  boundaryOptions,
  type DaemonView,
  type DashboardReader,
  DEFAULT_ERROR_MESSAGES,
  ERROR_STATUS,
  type ErrorCode,
  encodeBoundary,
  routes,
} from "@loopy/contract";
import type { Store } from "@loopy/core";
import { Cause, Effect, Exit, Schema } from "effect";
import { readBoundedBody } from "../http";
import { ServiceError } from "./error";
import type { EventReader } from "./events";
import { eventStream } from "./events";
import type { Service } from "./service";

// BOUNDARY: Route endpoints encode responses through their schema before calling this.
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function errorResponse(code: ErrorCode, message = DEFAULT_ERROR_MESSAGES[code]): Response {
  return json({ error: { code, message } }, ERROR_STATUS[code]);
}

export type RouteDependencies = {
  service: Service;
  onError?: (cause: Cause.Cause<unknown>) => void;
  store: Pick<Store, "nextWakeAt"> & Pick<DashboardReader, "runningCount"> & EventReader;
  /** The workspace a request means when it names none. */
  cwd: string;
  /** The largest request body a route reads. */
  maxBodyBytes: number;
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

type Search = (url: URL, request: Request) => Record<string, string>;

const searchParams: Search = (url) => Object.fromEntries(url.searchParams);

// A reconnecting EventSource resumes from the frame id it last received.
const eventSearch: Search = (url, request) => {
  const last = request.headers.get("Last-Event-ID");

  return last === null
    ? searchParams(url, request)
    : { ...searchParams(url, request), after: last };
};

type Handler<P, Q, B, R, E> = (context: {
  params: P;
  query: Q;
  body: B;
  request: Request;
  /** The workspace the query or body names, or the host's own when it names none. */
  workspace: string;
}) => Effect.Effect<R | Response, E>;

const namesWorkspace = Schema.is(Schema.Struct({ workspace: Schema.String }));

function makeEndpoint<P, Q, B, R, E>(
  route: Schemas<P, Q, B, R>,
  handle: Handler<P, Q, B, R, E>,
  { onError, maxBodyBytes, cwd }: Pick<RouteDependencies, "onError" | "maxBodyBytes" | "cwd">,
  search: Search,
) {
  const workspace = (...values: unknown[]) => values.find(namesWorkspace)?.workspace ?? cwd;

  const encode = encodeBoundary(route.response);

  return {
    ...route,
    async handle(params: Record<string, string>, request: Request, url: URL) {
      const exit = await Effect.runPromiseExit(
        parseRequest(route, params, search(url, request), request, maxBodyBytes).pipe(
          Effect.flatMap((parsed) =>
            handle({ ...parsed, request, workspace: workspace(parsed.query, parsed.body) }),
          ),
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
        }

        onError?.(exit.cause);

        return errorResponse("internal");
      }

      return exit.value;
    },
  };
}

// BOUNDARY: URL captures, search values and JSON enter the contract here. An unreadable body is
// a transport defect; one that is not JSON or not the route's shape is the caller's mistake.
const parseRequest = Effect.fn("Http.decodeRequest")(function* <P, Q, B>(
  route: Omit<Schemas<P, Q, B, unknown>, "method" | "response">,
  params: Record<string, string>,
  query: Record<string, string>,
  request: Request,
  maxBodyBytes: number,
) {
  const badRequest = () => new ServiceError("bad_request");

  const text =
    ["POST", "PUT"].includes(request.method) && request.body
      ? new TextDecoder().decode(
          yield* readBoundedBody(request.body, maxBodyBytes).pipe(
            Effect.catchTag("BodyLimitError", (error) =>
              Effect.fail(new ServiceError("bad_request", error.message)),
            ),
          ),
        )
      : undefined;

  const body: unknown =
    text === undefined
      ? undefined
      : yield* Effect.try({ try: () => JSON.parse(text), catch: badRequest });

  return {
    params: yield* Schema.decodeUnknownEffect(
      route.params,
      boundaryOptions,
    )(params).pipe(Effect.mapError(badRequest)),
    query: yield* Schema.decodeUnknownEffect(
      route.query,
      boundaryOptions,
    )(query).pipe(Effect.mapError(badRequest)),
    body: yield* Schema.decodeUnknownEffect(
      route.body,
      boundaryOptions,
    )(body).pipe(Effect.mapError(badRequest)),
  };
});

export function apiRoutes({
  service,
  store,
  cwd,
  daemon,
  onError,
  maxBodyBytes,
}: RouteDependencies) {
  const endpoint = <P, Q, B, R, E>(
    route: Schemas<P, Q, B, R>,
    handle: Handler<P, Q, B, R, E>,
    search = searchParams,
  ) => makeEndpoint(route, handle, { onError, maxBodyBytes, cwd }, search);

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
    endpoint(routes.graph, ({ params: { slug }, workspace }) => service.graph(slug, workspace)),
    endpoint(routes.runGraph, ({ params: { id } }) => service.runGraph(id)),
    endpoint(routes.source, ({ params: { slug }, workspace }) =>
      service.loopySource(slug, workspace),
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
    endpoint(routes.schedules, ({ workspace }) => service.listSchedules(workspace)),
    endpoint(routes.putSchedule, ({ params: { slug }, body, workspace }) =>
      service.putSchedule(slug, body, workspace),
    ),
    endpoint(routes.setScheduleEnabled, ({ params: { slug }, body, workspace }) =>
      service.setScheduleEnabled(slug, body.enabled, workspace),
    ),
    endpoint(routes.deleteSchedule, ({ params: { slug }, workspace }) =>
      service.deleteSchedule(slug, workspace),
    ),
    endpoint(routes.loopies, ({ workspace }) => service.listLoopies(workspace)),
    endpoint(routes.runs, ({ query }) => service.listRuns(query)),
    endpoint(routes.run, ({ params: { id } }) => service.runSnapshot(id)),
    endpoint(routes.logs, ({ params: { id }, query }) => service.logs(id, query)),
    endpoint(routes.startRun, ({ params: { slug }, body, workspace }) =>
      service.startRun(slug, body.input, workspace),
    ),
    endpoint(routes.resumeRun, ({ params: { id } }) => service.resumeRun(id)),
    endpoint(routes.cancelRun, ({ params: { id } }) => service.cancelRun(id)),
    endpoint(routes.resolveHook, ({ params: { token }, body }) =>
      service.resolveHook(token, body.payload),
    ),
    // Daemon identity and capacity belong to the host, not the portable service.
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
    endpoint(
      routes.events,
      ({ query, request }) => eventStream(store, service, query, request.signal),
      eventSearch,
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
  const path = decodeURIComponent(url.pathname);

  for (const route of table) {
    const params = match(route.path, path);

    if (route.method === request.method && params) {
      return await route.handle(params, request, url);
    }
  }

  return errorResponse("not_found");
}
