import { z } from "zod";
import {
  type DaemonView,
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  routes,
} from "../../contract/index.js";
import { type LoopyService, ServiceError } from "../service.js";
import type { SqliteRunStore } from "../store.js";
import { eventStream } from "./events.js";

const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  unknown_hook: 404,
  not_claimable: 409,
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

type Dependencies = {
  service: LoopyService;
  store: SqliteRunStore;
  cwd: string;
  daemon: Pick<DaemonView, "startedAt" | "concurrency">;
};

type Schemas<P, Q, B, R> = {
  method: string;
  path: string;
  params: z.ZodType<P>;
  query: z.ZodType<Q>;
  body: z.ZodType<B>;
  response: z.ZodType<R>;
};

function endpoint<P, Q, B, R>(
  route: Schemas<P, Q, B, R>,
  handle: (context: { params: P; query: Q; body: B; request: Request }) => Promise<R | Response>,
) {
  return {
    ...route,
    async handle(params: Record<string, string>, request: Request, url: URL) {
      const parsed = await parseRequest(route, params, request, url);
      const result = await handle({ ...parsed, request });

      if (result instanceof Response) {
        return result;
      }

      return json(route.response.parse(result));
    },
  };
}

// BOUNDARY: URL captures, search values and JSON enter the contract here.
async function parseRequest<P, Q, B>(
  route: Omit<Schemas<P, Q, B, unknown>, "method" | "response">,
  params: Record<string, string>,
  request: Request,
  url: URL,
) {
  try {
    const query = Object.fromEntries(url.searchParams);

    if (route.path === routes.events.path) {
      const last = request.headers.get("Last-Event-ID");

      if (last !== null) {
        query.after = last;
      }
    }

    const body: unknown =
      ["POST", "PUT"].includes(request.method) && request.body ? await request.json() : undefined;

    return {
      params: route.params.parse(params),
      query: route.query.parse(query),
      body: route.body.parse(body),
    };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new ServiceError("bad_request");
    }

    throw error;
  }
}

export function apiRoutes({ service, store, cwd, daemon }: Dependencies) {
  return [
    endpoint(routes.secrets, async () => service.listSecrets()),
    endpoint(routes.putSecret, async ({ params, body }) =>
      service.putSecret(params.name, body.value),
    ),
    endpoint(routes.deleteSecret, async ({ params }) => service.deleteSecret(params.name)),
    endpoint(routes.generateTypes, async ({ body }) => service.generateTypes(body)),
    endpoint(routes.resolveNamedHook, async ({ params, body }) =>
      service.resolveNamedHook(params.id, params.name, body.payload),
    ),
    endpoint(routes.putLoopy, async ({ params: { slug }, body }) => service.putLoopy(slug, body)),
    endpoint(routes.graph, async ({ params: { slug }, query }) =>
      service.graph(slug, query.workspace ?? cwd),
    ),
    endpoint(routes.schedules, async ({ query }) => service.listSchedules(query.workspace)),
    endpoint(routes.putSchedule, async ({ params: { slug }, body, query }) =>
      service.putSchedule(slug, body, query.workspace),
    ),
    endpoint(routes.setScheduleEnabled, async ({ params: { slug }, body, query }) =>
      service.setScheduleEnabled(slug, body.enabled, query.workspace),
    ),
    endpoint(routes.deleteSchedule, async ({ params: { slug }, query }) =>
      service.deleteSchedule(slug, query.workspace),
    ),
    endpoint(routes.loopies, async ({ query }) => service.listLoopies(query.workspace)),
    endpoint(routes.runs, async ({ query }) => service.listRuns(query)),
    endpoint(routes.run, async ({ params: { id } }) => service.runSnapshot(id)),
    endpoint(routes.logs, async ({ params: { id }, query }) => {
      await service.requireRun(id);

      return store.getLogs(id, query.after);
    }),
    endpoint(routes.startRun, async ({ params: { slug }, body }) =>
      service.startRun(slug, body.input, body.workspace ?? cwd),
    ),
    endpoint(routes.resumeRun, async ({ params: { id } }) => service.resumeRun(id)),
    endpoint(routes.cancelRun, async ({ params: { id } }) => service.cancelRun(id)),
    endpoint(routes.resolveHook, async ({ params: { token }, body }) =>
      service.resolveHook(token, body.payload),
    ),
    endpoint(routes.daemon, async () => ({
      pid: process.pid,
      startedAt: daemon.startedAt,
      concurrency: daemon.concurrency,
      running: (await store.listRuns({ status: "running" })).length,
      nextWakeAt: (await store.nextWakeAt()) ?? null,
    })),
    endpoint(routes.events, async ({ query, request }) =>
      eventStream(store, service, query, request.signal),
    ),
    endpoint(routes.cursor, async () => service.cursor()),
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
