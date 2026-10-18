import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { errorMessage } from "../../core/index.js";
import { daemonUrl } from "../daemon-file.js";
import { serveAsset, snapshotAssets } from "./assets.js";
import { apiRoutes, dispatch, errorResponse, json } from "./routes.js";

export const DEFAULT_PORT = 4310;

export type ServerOptions = Omit<Parameters<typeof apiRoutes>[0], "cwd"> & {
  token: string;
  cwd?: string;
  port?: number;
  assets?: string;
};

function bearerMatches(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function originRejection(request: Request, url: URL, ownOrigin: string): Response | undefined {
  if (
    url.origin !== ownOrigin ||
    request.headers.get("host") !== ownOrigin.slice("http://".length)
  ) {
    return errorResponse("forbidden", "Invalid host.");
  }

  const origin = request.headers.get("origin");

  if (origin && origin !== ownOrigin) {
    return errorResponse("forbidden");
  }

  return undefined;
}

export function startServer(options: ServerOptions) {
  const { token } = options;

  const assets = snapshotAssets(
    resolve(options.assets ?? resolve(import.meta.dir, "../../../dist/dashboard")),
  );

  const table = apiRoutes({ ...options, cwd: resolve(options.cwd ?? process.cwd()) });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    maxRequestBodySize: 64 * 1024 * 1024,
    fetch: (request, server) => respond(request, { assets, table, token }, server),
  });

  return {
    port: server.port ?? DEFAULT_PORT,
    url: daemonUrl({ port: server.port ?? DEFAULT_PORT, token }),
    async stop() {
      await server.stop(true);
    },
  };
}

type RequestOptions = {
  assets: ReturnType<typeof snapshotAssets>;
  table: ReturnType<typeof apiRoutes>;
  token: string;
};

async function respond(
  request: Request,
  options: RequestOptions,
  server: Pick<Bun.Server<undefined>, "port" | "timeout">,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rejection = originRejection(request, url, `http://127.0.0.1:${server.port}`);

    if (rejection) {
      return rejection;
    }

    const path = decodeURIComponent(url.pathname);

    if (path !== "/api" && !path.startsWith("/api/")) {
      return serveAsset(options.assets, request, path);
    }

    if (!bearerMatches(request, options.token)) {
      return errorResponse("unauthorized");
    }

    const response = await dispatch(options.table, request, url);

    if (response.headers.get("Content-Type") === "text/event-stream") {
      server.timeout(request, 0);
    }

    return response;
  } catch (error) {
    return error instanceof URIError
      ? json({ error: errorMessage(error) }, 400)
      : errorResponse("internal", errorMessage(error));
  }
}
