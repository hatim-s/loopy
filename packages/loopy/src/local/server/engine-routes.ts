import { requireNonEmptyString } from "../../core/index.js";
import { engineRunDetail } from "../../runtime/index.js";
import { listLegacyRuns } from "../engine-local.js";
import { json, type Route, type RouteDependencies } from "./routes.js";

type Dependencies = Pick<RouteDependencies, "home" | "engineStore" | "runtime">;

async function detail({ engineStore, runtime }: Dependencies, id: string) {
  const store = engineStore();
  const run = await store.getRun(id);

  if (run) {
    return json(await engineRunDetail(store, run));
  }

  const legacy = runtime();
  const old = await legacy.getRun(id);

  if (!old) {
    return json({ error: "Run not found. Use loopy runs to find a run ID." }, 404);
  }

  return json({
    run: old,
    attempts: await legacy.getAttempts(id),
    events: await legacy.getEvents(id),
  });
}

async function logs({ engineStore }: Dependencies, id: string, url: URL) {
  const store = engineStore();

  if (!(await store.getRun(id))) {
    return json({ error: "Run not found. Use loopy runs to find a run ID." }, 404);
  }

  const after = Number(url.searchParams.get("after") ?? 0);

  if (!Number.isSafeInteger(after) || after < 0) {
    throw new Error("Invalid log cursor. Supply a nonnegative integer after value.");
  }

  return json(await store.getLogs(id, after));
}

export function engineRoutes(dependencies: Dependencies): Route[] {
  const { engineStore, home } = dependencies;

  return [
    {
      method: "GET",
      pattern: /^\/api\/runs$/,
      handle: async ({ url }) => {
        const slug = url.searchParams.get("slug") ?? undefined;

        return json(
          [...(await engineStore().listRuns({ slug })), ...(await listLegacyRuns(home, slug))].sort(
            (a, b) => b.createdAt.localeCompare(a.createdAt),
          ),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(?<id>[^/]+)$/,
      handle: async ({ params }) => detail(dependencies, requireNonEmptyString(params.id, "id")),
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(?<id>[^/]+)\/logs$/,
      handle: async ({ params, url }) =>
        logs(dependencies, requireNonEmptyString(params.id, "id"), url),
    },
  ];
}
