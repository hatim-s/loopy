import { requireNonEmptyString } from "../../core/index.js";
import { engineRunDetail } from "../../runtime/index.js";
import type { SqliteRunStore } from "../engine-store.js";
import type { Loopies } from "../loopies.js";

type RouteContext = { params: Record<string, string>; request: Request; url: URL };

type Route = {
  method: "GET";
  pattern: RegExp;
  handle: (context: RouteContext) => Promise<Response>;
};

type RouteDependencies = { cwd: string; registry: Loopies; engineStore: () => SqliteRunStore };

// BOUNDARY: Response serialization accepts validated route payloads and errors.
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function detail(store: SqliteRunStore, id: string) {
  const run = await store.getRun(id);

  if (!run) {
    return json({ error: "Run not found. Use loopy runs to find a run ID." }, 404);
  }

  return json(await engineRunDetail(store, run));
}

async function logs(store: SqliteRunStore, id: string, url: URL) {
  if (!(await store.getRun(id))) {
    return json({ error: "Run not found. Use loopy runs to find a run ID." }, 404);
  }

  const after = Number(url.searchParams.get("after") ?? 0);

  if (!Number.isSafeInteger(after) || after < 0) {
    throw new Error("Invalid log cursor. Supply a nonnegative integer after value.");
  }

  return json(await store.getLogs(id, after));
}

export function apiRoutes({ cwd, registry, engineStore }: RouteDependencies): Route[] {
  return [
    { method: "GET", pattern: /^\/api\/config$/, handle: async () => json({ cwd }) },
    { method: "GET", pattern: /^\/api\/loopies$/, handle: async () => json(registry.list()) },
    {
      method: "GET",
      pattern: /^\/api\/runs$/,
      handle: async ({ url }) =>
        json(await engineStore().listRuns({ slug: url.searchParams.get("slug") ?? undefined })),
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(?<id>[^/]+)$/,
      handle: async ({ params }) => detail(engineStore(), requireNonEmptyString(params.id, "id")),
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(?<id>[^/]+)\/logs$/,
      handle: async ({ params, url }) =>
        logs(engineStore(), requireNonEmptyString(params.id, "id"), url),
    },
  ];
}

export async function dispatch(routes: Route[], request: Request, url: URL, path: string) {
  for (const route of routes) {
    if (route.method !== request.method) {
      continue;
    }

    const match = route.pattern.exec(path);

    if (match) {
      return route.handle({ params: { ...match.groups }, request, url });
    }
  }

  return json({ error: "Endpoint not found. Check the API path and method." }, 404);
}
