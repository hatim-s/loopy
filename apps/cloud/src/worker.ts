import { errorResponse, json } from "../../../packages/loopy/src/service/index.js";
import type { Environment } from "./environment.js";
import { principals } from "./environment.js";
import { acceptsOrigin, boundedRequest } from "./http.js";

export { Workspace } from "./workspace.js";

async function handle(request: Request, env: Environment) {
  const url = new URL(request.url);

  if (env.LOOPY_STAGE !== "local" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    return json(
      {
        error: {
          code: "forbidden",
          message:
            "This configuration is local-only. Phase 2 requires approval and a deployment configuration.",
        },
      },
      403,
    );
  }

  if (url.pathname === "/health") {
    return json({ service: "loopy-cloud", stage: "local" });
  }

  const principal = principals(env).find(
    ({ token }) => request.headers.get("Authorization") === `Bearer ${token}`,
  );

  if (!principal) {
    return errorResponse("unauthorized");
  }

  if (!acceptsOrigin(request)) {
    return errorResponse("forbidden", "Use the API from its own origin or a trusted local proxy.");
  }

  const bounded = await boundedRequest(request);

  if (bounded instanceof Response) {
    return bounded;
  }

  const headers = new Headers(bounded.headers);
  headers.set("X-Loopy-Workspace", principal.workspace);
  const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(principal.workspace));

  const response = await stub.fetch(bounded.url, {
    method: bounded.method,
    headers: [...headers],
    body: bounded.body ? await bounded.arrayBuffer() : undefined,
  });

  return response;
}

export default {
  async fetch(request: Request, env: Environment) {
    try {
      return await handle(request, env);
    } catch {
      return errorResponse("internal");
    }
  },
};
