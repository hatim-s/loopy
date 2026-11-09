import { resolve } from "node:path";
import { LOCAL_MAX_REQUEST_BYTES } from "@loopy/contract";
import { bearerMatches } from "../../http";
import { apiRoutes, dispatch, errorResponse, type RouteDependencies } from "../../service";
import { daemonUrl } from "../daemon/file";
import { serveAsset, snapshotAssets } from "./assets";
import { type OriginPolicy, originSecurity } from "./security";

// The local listener caps bodies itself, so callers never choose the route limit.
export type ServerOptions = Omit<RouteDependencies, "maxBodyBytes"> & {
  token: string;
  port: number;
  /** The built dashboard directory, which the CLI resolves from its own install layout. */
  assets: string;
  publicOrigin?: string;
  allowedOrigins?: readonly string[];
};

export function startServer(options: ServerOptions) {
  // Validate configured origins before opening a listener.
  originSecurity({
    publicOrigin: options.publicOrigin ?? "http://127.0.0.1",
    allowedOrigins: options.allowedOrigins,
  });

  let handler: ReturnType<typeof createRequestHandler>;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    maxRequestBodySize: LOCAL_MAX_REQUEST_BYTES,
    async fetch(request, server) {
      const response = await handler(request);

      if (response.headers.get("Content-Type") === "text/event-stream") {
        server.timeout(request, 0);
      }

      return response;
    },
  });

  try {
    handler = createRequestHandler({
      ...options,
      publicOrigin: options.publicOrigin ?? `http://127.0.0.1:${server.port}`,
    });
  } catch (error) {
    void server.stop(true);
    throw error;
  }

  const port = server.port ?? options.port;

  return {
    port,
    url: daemonUrl({ port, token: options.token }),
    async stop() {
      await server.stop(true);
    },
  };
}

export function createRequestHandler(options: ServerOptions & OriginPolicy) {
  if (!options.token) {
    throw new Error("The HTTP server requires a nonempty bearer token.");
  }

  const assets = snapshotAssets(resolve(options.assets));

  const table = apiRoutes({
    ...options,
    cwd: resolve(options.cwd),
    maxBodyBytes: LOCAL_MAX_REQUEST_BYTES,
  });

  const security = originSecurity(options);

  return (request: Request) => respond(request, { assets, table, token: options.token, security });
}

type RequestOptions = {
  assets: ReturnType<typeof snapshotAssets>;
  table: ReturnType<typeof apiRoutes>;
  token: string;
  security: ReturnType<typeof originSecurity>;
};

async function respond(request: Request, options: RequestOptions): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rejection = options.security.reject(request);

    if (rejection) {
      return rejection;
    }

    const path = decodeURIComponent(url.pathname);

    if (path !== "/api" && !path.startsWith("/api/")) {
      return serveAsset(options.assets, request, path);
    }

    if (request.method === "OPTIONS") {
      return options.security.preflight(request);
    }

    if (!bearerMatches(request.headers.get("authorization"), options.token)) {
      return options.security.cors(request, errorResponse("unauthorized"));
    }

    const response = await dispatch(options.table, request, url);

    return options.security.cors(request, response);
  } catch (error) {
    return options.security.cors(
      request,
      error instanceof URIError
        ? errorResponse("bad_request", "The request path has invalid percent-encoding.")
        : errorResponse("internal"),
    );
  }
}
