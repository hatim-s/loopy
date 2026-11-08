import { CLOUD_MAX_REQUEST_BYTES } from "@loopy/contract";
import { bearerMatches, readBoundedBody } from "@loopy/runtime/http";
import { errorResponse, json } from "@loopy/runtime/service";
import { Effect } from "effect";
import { cloudConfig, type Environment, servesLocally } from "./environment";
import { acceptsOrigin, mebibytes } from "./http";
import { platform } from "./operation";
import { RECEIPTS_PATH, routeReceipts } from "./receipts/route";

export { SandboxReceipts } from "./receipts";

export { Workspace } from "./workspace";

function handle(request: Request, env: Environment) {
  return Effect.gen(function* () {
    const url = new URL(request.url);

    if (!servesLocally(env, url)) {
      return errorResponse(
        "forbidden",
        "This configuration is local-only. Phase 2 requires approval and a deployment configuration.",
      );
    }

    if (url.pathname === "/health") {
      return json({ service: "loopy-cloud", stage: "local" });
    }

    if (url.pathname === RECEIPTS_PATH) {
      return yield* routeReceipts(request, env);
    }

    const authorization = request.headers.get("Authorization");

    // Every principal is compared so the match position does not show in the timing.
    const [principal] = cloudConfig(env).principals.filter(({ token }) =>
      bearerMatches(authorization, token),
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

    const body = yield* readBoundedBody(request.body, CLOUD_MAX_REQUEST_BYTES).pipe(
      Effect.catchTag("BodyLimitError", () => Effect.succeed(null)),
    );

    if (body === null) {
      return errorResponse(
        "bad_request",
        `Request exceeds the ${mebibytes(CLOUD_MAX_REQUEST_BYTES)} cloud artifact limit.`,
      );
    }

    const headers = new Headers(request.headers);
    headers.set("X-Loopy-Workspace", principal.workspace);
    const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(principal.workspace));

    return yield* platform("forward workspace request", () =>
      stub.fetch(request.url, {
        method: request.method,
        headers: [...headers],
        body: request.body === null ? undefined : body,
      }),
    );
  });
}

export default {
  fetch(request: Request, env: Environment) {
    return Effect.runPromise(
      handle(request, env).pipe(Effect.catchCause(() => Effect.succeed(errorResponse("internal")))),
    );
  },
};
