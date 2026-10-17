import { z } from "zod";
import { type ErrorCode, errorBodySchema, routes } from "../../contract/index.js";
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
};

// BOUNDARY: HTTP responses contain contract views or sanitized errors.
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

type Dependencies = { service: LoopyService; store: SqliteRunStore; cwd: string };

type Schemas<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType> = {
  method: string;
  path: string;
  params: P;
  query: Q;
  body: B;
  response: R;
};

function endpoint<
  P extends z.ZodType,
  Q extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
>(
  route: Schemas<P, Q, B, R>,
  handle: (context: {
    params: z.output<P>;
    query: z.output<Q>;
    body: z.output<B>;
    request: Request;
  }) => Promise<z.input<R> | Response>,
) {
  return {
    ...route,
    // BOUNDARY: Path captures enter their route schema with the HTTP request.
    async handle(params: unknown, request: Request, url: URL) {
      const parsed = await parseRequest(route, params, request, url);
      const result = await handle({ ...parsed, request });

      if (result instanceof Response) {
        return result;
      }

      // Strict response schemas reject a view that grew a field the contract does not know.
      return json(route.response.parse(result));
    },
  };
}

// BOUNDARY: URL captures, search values and JSON enter the contract here.
async function parseRequest<
  P extends z.ZodType,
  Q extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
>(route: Schemas<P, Q, B, R>, params: unknown, request: Request, url: URL) {
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

export function apiRoutes({ service, store, cwd }: Dependencies) {
  return [
    endpoint(routes.schedules, async () => service.listSchedules()),
    endpoint(routes.putSchedule, async ({ params: { slug }, body }) =>
      service.putSchedule(slug, body),
    ),
    endpoint(routes.setScheduleEnabled, async ({ params: { slug }, body }) =>
      service.setScheduleEnabled(slug, body.enabled),
    ),
    endpoint(routes.deleteSchedule, async ({ params: { slug } }) => service.deleteSchedule(slug)),
    endpoint(routes.loopies, async () => service.listLoopies()),
    endpoint(routes.runs, async ({ query }) => service.listRuns(query)),
    endpoint(routes.run, async ({ params: { id } }) => {
      const snapshot = await service.runSnapshot(id);

      if (!snapshot) {
        throw new ServiceError("not_found");
      }

      return snapshot;
    }),
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
    endpoint(routes.daemon, async () => service.daemon()),
    endpoint(routes.events, async ({ query, request }) =>
      eventStream(store, service, query, request.signal),
    ),
    endpoint(routes.cursor, async () => service.cursor()),
  ];
}

function match(pattern: string, path: string): object | undefined {
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

export async function dispatch(
  table: ReturnType<typeof apiRoutes>,
  request: Request,
  url: URL,
  path: string,
) {
  try {
    for (const route of table) {
      const params = match(route.path, path);

      if (route.method === request.method && params) {
        return await route.handle(params, request, url);
      }
    }

    throw new ServiceError("not_found");
  } catch (error) {
    if (error instanceof ServiceError) {
      return json(
        errorBodySchema.parse({ error: { code: error.code, message: error.message } }),
        STATUS[error.code],
      );
    }

    throw error;
  }
}
