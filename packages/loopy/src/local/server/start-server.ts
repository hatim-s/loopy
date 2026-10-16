import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { errorMessage } from "../../core/index.js";
import { defaultHome } from "../home.js";
import { Registry } from "../registry.js";
import { openRunStore } from "../store.js";
import { serveAsset, snapshotAssets } from "./assets.js";
import { apiRoutes, dispatch, json } from "./routes.js";

export const DEFAULT_PORT = 4310;

const MAX_BODY_BYTES = 1024 * 1024;

export type ServerOptions = {
  home?: string;
  cwd?: string;
  port?: number;
  assets?: string;
};

function bearerMatches(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Only the loopback origin this server answers on may call it. */
function originRejection(request: Request, url: URL, ownOrigin: string): Response | undefined {
  if (
    url.origin !== ownOrigin ||
    request.headers.get("host") !== ownOrigin.slice("http://".length)
  ) {
    return json({ error: "Invalid host." }, 403);
  }

  const origin = request.headers.get("origin");

  if (origin && origin !== ownOrigin) {
    return json({ error: "Cross-origin access is disabled." }, 403);
  }

  return undefined;
}

export function startServer(options: ServerOptions = {}) {
  const home = options.home ?? defaultHome();
  const cwd = resolve(options.cwd ?? process.cwd());
  const registry = new Registry(home, cwd);
  let store: ReturnType<typeof openRunStore> | undefined;
  const getStore = () => (store ??= openRunStore(home));
  const token = crypto.randomUUID();

  const assets = snapshotAssets(
    resolve(options.assets ?? resolve(import.meta.dir, "../../../dist/studio")),
  );

  const routes = apiRoutes({ registry, getStore });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const rejection = originRejection(request, url, `http://127.0.0.1:${server.port}`);

        if (rejection) {
          return rejection;
        }

        const path = decodeURIComponent(url.pathname);

        if (!path.startsWith("/api/")) {
          return serveAsset(assets, request, path);
        }

        if (!bearerMatches(request, token)) {
          return json({ error: "Open the viewer URL printed by loopy ui to authenticate." }, 401);
        }

        return await dispatch(routes, request, url, path);
      } catch (error) {
        return json({ error: errorMessage(error) }, error instanceof URIError ? 400 : 500);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/#token=${token}`,
    async stop() {
      await server.stop(true);
      store?.close();
    },
  };
}
