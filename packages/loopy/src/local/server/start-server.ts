import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { errorMessage } from "../../core/index.js";
import { daemonUrl } from "../daemon-file.js";
import { serveAsset, snapshotAssets } from "./assets.js";
import { apiRoutes, dispatch, errorResponse, json } from "./routes.js";
import { type OriginPolicy, originSecurity } from "./security.js";

export const DEFAULT_PORT = 4310;

export type ServerOptions = Omit<Parameters<typeof apiRoutes>[0], "cwd"> & {
  token: string;
  cwd?: string;
  port?: number;
  assets?: string;
  publicOrigin?: string;
  allowedOrigins?: readonly string[];
};

function bearerMatches(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function startServer(options: ServerOptions) {
  // Validate configured origins before opening a listener.
  originSecurity({
    publicOrigin: options.publicOrigin ?? "http://127.0.0.1",
    allowedOrigins: options.allowedOrigins,
  });

  let handler: ReturnType<typeof createRequestHandler>;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    maxRequestBodySize: 64 * 1024 * 1024,
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

  return {
    port: server.port ?? DEFAULT_PORT,
    url: daemonUrl({ port: server.port ?? DEFAULT_PORT, token: options.token }),
    async stop() {
      await server.stop(true);
    },
  };
}

/** Cloud hosts supply their trusted public origin and existing service/store dependencies. */
export function createRequestHandler(options: ServerOptions & OriginPolicy) {
  if (!options.token) {
    throw new Error("The HTTP server requires a nonempty bearer token.");
  }

  const assets = snapshotAssets(
    resolve(options.assets ?? resolve(import.meta.dir, "../../../dist/dashboard")),
  );

  const table = apiRoutes({ ...options, cwd: resolve(options.cwd ?? process.cwd()) });
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

    if (!bearerMatches(request, options.token)) {
      return options.security.cors(request, errorResponse("unauthorized"));
    }

    const response = await dispatch(options.table, request, url);

    return options.security.cors(request, response);
  } catch (error) {
    return options.security.cors(
      request,
      error instanceof URIError
        ? json({ error: errorMessage(error) }, 400)
        : errorResponse("internal", errorMessage(error)),
    );
  }
}
