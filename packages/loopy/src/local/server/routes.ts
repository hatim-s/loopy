import type {
  Json,
  RunDetail,
  RunRecord,
  UnknownRecord,
  Workflow,
  WorkflowSummary,
} from "../../core/index.js";
import {
  allowKeys,
  requireBoolean,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
} from "../../core/index.js";
import type { Runtime } from "../../runtime/index.js";
import { assertJson } from "../../runtime/index.js";
import { localRunOptions } from "../process.js";
import type { Registry } from "../registry/registry.js";

export type RouteContext = { params: Record<string, string>; request: Request; url: URL };

export type Route = {
  method: "GET" | "POST";
  pattern: RegExp;
  handle: (context: RouteContext) => Promise<Response>;
};

export type RouteDependencies = {
  cwd: string;
  registry: Registry;
  runtime: Runtime;
  launch: (run: RunRecord, retryUncertain?: boolean) => void;
};

type ApiResult = Json | Workflow | WorkflowSummary[] | RunRecord | RunRecord[] | RunDetail;

export function json(data: ApiResult, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function jsonBody(request: Request): Promise<UnknownRecord> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error("Send an application/json request body.");
  }

  return requireRecord(await request.json(), "The request body");
}

function notFound(): Response {
  return json({ error: "Run not found." }, 404);
}

export function apiRoutes({ cwd, registry, runtime, launch }: RouteDependencies): Route[] {
  return [
    { method: "GET", pattern: /^\/api\/config$/, handle: async () => json({ cwd }) },
    { method: "GET", pattern: /^\/api\/workflows$/, handle: async () => json(registry.list()) },
    {
      method: "GET",
      pattern: /^\/api\/workflows\/(?<slug>[^/]+)$/,
      handle: async ({ params }) =>
        json(registry.get(requireNonEmptyString(params.slug, "slug")).workflow),
    },
    {
      method: "GET",
      pattern: /^\/api\/runs$/,
      handle: async ({ url }) =>
        json(await runtime.listRuns(url.searchParams.get("slug") ?? undefined)),
    },
    {
      method: "POST",
      pattern: /^\/api\/runs$/,
      handle: async ({ request }) => {
        const body = await jsonBody(request);
        allowKeys(body, "The request body", ["slug", "mode", "input"]);
        const slug = requireNonEmptyString(body.slug, "slug");
        const mode = requireOneOf(body.mode, ["sandbox", "full"], "mode");
        const input = body.input === undefined ? {} : body.input;
        assertJson(input);
        const saved = registry.get(slug);

        const run = await runtime.createRun(saved.workflow, input, {
          ...localRunOptions(cwd, mode),
          secretBindings: saved.secretBindings,
        });

        launch(run);

        return json(run, 202);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(?<id>[^/]+)$/,
      handle: async ({ params }) => {
        const run = await runtime.getRun(requireNonEmptyString(params.id, "id"));

        if (!run) {
          return notFound();
        }

        return json({
          run,
          attempts: await runtime.getAttempts(run.id),
          events: await runtime.getEvents(run.id),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/runs\/(?<id>[^/]+)\/resume$/,
      handle: async ({ params, request }) => {
        const run = await runtime.getRun(requireNonEmptyString(params.id, "id"));

        if (!run) {
          return notFound();
        }

        const body = await jsonBody(request);
        allowKeys(body, "The request body", ["retryUncertain"]);

        const retryUncertain =
          body.retryUncertain === undefined
            ? false
            : requireBoolean(body.retryUncertain, "retryUncertain");

        if (run.status === "succeeded" || run.status === "running") {
          throw new Error(`Cannot resume a ${run.status} run.`);
        }

        launch(run, retryUncertain);

        const resumed = await runtime.getRun(run.id);

        if (!resumed) {
          return notFound();
        }

        return json(resumed, 202);
      },
    },
  ];
}

/** Runs the first route whose method and pattern match; named groups become params. */
export async function dispatch(
  routes: Route[],
  request: Request,
  url: URL,
  path: string,
): Promise<Response> {
  for (const route of routes) {
    if (route.method !== request.method) {
      continue;
    }

    const match = route.pattern.exec(path);

    if (match) {
      return route.handle({ params: { ...match.groups }, request, url });
    }
  }

  return json({ error: "Endpoint not found." }, 404);
}
