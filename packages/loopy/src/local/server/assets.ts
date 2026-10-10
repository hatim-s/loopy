import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Asset = { body: Blob; type: string };

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

/** Reads every regular file once so later builds cannot swap code under a running viewer. */
export function snapshotAssets(directory: string): Map<string, Asset> {
  const files = new Map<string, Asset>();

  const visit = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
        continue;
      }

      const filename = join(path, entry.name);
      const key = `${prefix}${entry.name}`;

      if (entry.isDirectory()) {
        visit(filename, `${key}/`);
      } else if (entry.isFile()) {
        files.set(key, {
          body: new Blob([new Uint8Array(readFileSync(filename))]),
          type: Bun.file(filename).type,
        });
      }
    }
  };

  if (existsSync(directory)) {
    visit(directory, "");
  }

  return files;
}

export function serveAsset(assets: Map<string, Asset>, request: Request, path: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", { status: 405 });
  }

  const file = assets.get(path === "/" ? "index.html" : path.replace(/^\/+/, ""));

  if (!file) {
    return new Response("Viewer assets are missing. Run bun run build first.", { status: 404 });
  }

  return new Response(request.method === "HEAD" ? null : file.body, {
    headers: {
      "Content-Type": file.type,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    },
  });
}
