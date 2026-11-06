import { errorResponse, json } from "@loopy/runtime/service";
import { Effect } from "effect";
import type { Environment } from "./environment";
import { principals } from "./environment";
import { acceptsOrigin, boundedRequest } from "./http";
import { platform } from "./operation";
import { RECEIPTS_PATH, routeReceipts } from "./receipts/route";

export { SandboxReceipts } from "./receipts";

export { Workspace } from "./workspace";

function handle(request: Request, env: Environment) {
  return Effect.gen(function* () {
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

    if (url.pathname === RECEIPTS_PATH) {
      return yield* routeReceipts(request, env);
    }

    const principal = principals(env).find(
      ({ token }) => request.headers.get("Authorization") === `Bearer ${token}`,
    );

    if (!principal) {
      return errorResponse("unauthorized");
    }

    if (!acceptsOrigin(request)) {
      return errorResponse(
        "forbidden",
        "Use the API from its own origin or a trusted local proxy.",
      );
    }

    const bounded = yield* boundedRequest(request);

    if (bounded instanceof Response) {
      return bounded;
    }

    const headers = new Headers(bounded.headers);
    headers.set("X-Loopy-Workspace", principal.workspace);
    const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(principal.workspace));

    const body = bounded.body
      ? yield* platform("read request", () => bounded.arrayBuffer())
      : undefined;

    const response = yield* platform("forward workspace request", () =>
      stub.fetch(bounded.url, {
        method: bounded.method,
        headers: [...headers],
        body,
      }),
    );

    return response;
  });
}

export default {
  fetch(request: Request, env: Environment) {
    return Effect.runPromise(
      handle(request, env).pipe(Effect.catchCause(() => Effect.succeed(errorResponse("internal")))),
    );
  },
};
