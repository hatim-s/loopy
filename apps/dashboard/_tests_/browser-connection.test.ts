import { afterEach, expect, test } from "bun:test";
import { routes } from "loopy/contract";
import { httpBaseUrl } from "../src/backend/config.ts";
import { httpTransport, localHttpBackend } from "../src/backend/local-http.ts";
import { browserConnection } from "../src/lib/connection.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

test("redirects never forward a bearer token, including same-origin redirects", async () => {
  let redirected = 0;

  const destination = Bun.serve({
    port: 0,
    fetch() {
      redirected++;

      return Response.json({ cursor: 0, epoch: "e" });
    },
  });

  let target = destination.url.href;

  const source = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/other") {
        redirected++;

        return Response.json({ cursor: 0, epoch: "e" });
      }

      return Response.redirect(target);
    },
  });

  cleanups.push(async () => {
    await source.stop(true);
    await destination.stop(true);
  });

  for (const location of [destination.url.href, new URL("/other", source.url).href]) {
    target = location;
    await expect(
      localHttpBackend({ baseUrl: source.url.origin, token: "isolated" }).cursor(
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "unreachable" });
    expect(redirected).toBe(0);
  }
});

test("base URL prefix is preserved and URL credentials or selectors are rejected", async () => {
  let path = "";

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      path = new URL(request.url).pathname;

      return Response.json({ cursor: 0, epoch: "e" });
    },
  });

  cleanups.push(async () => {
    await server.stop(true);
  });
  await localHttpBackend({ baseUrl: `${server.url.origin}/loopy/`, token: null }).cursor(
    AbortSignal.timeout(1000),
  );
  expect(path).toBe("/loopy/api/cursor");
  const transport = httpTransport({ baseUrl: server.url.origin, token: null });
  await expect(
    transport.send(routes.log, { params: { id: 17 }, query: {}, body: undefined }),
  ).rejects.toMatchObject({ code: "malformed_response" });
  expect(path).toBe("/api/logs/17");
  await expect(
    transport.send(routes.event, { params: { sequence: 23 }, query: {}, body: undefined }),
  ).rejects.toMatchObject({ code: "malformed_response" });
  expect(path).toBe("/api/event-history/23");

  for (const url of [
    "https://user:pass@api.example",
    "https://api.example?api=https://evil.example",
    "https://api.example#token=x",
    "file:///tmp/api",
    "/api",
  ]) {
    expect(() => httpBaseUrl(url)).toThrow();
  }
});

test("bootstrap removes secrets before storage, scopes them by API, and ignores query origins", () => {
  const values = new Map<string, string>([["loopy-token", "old"]]);

  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };

  let cleaned = "";

  const options = {
    baseUrl: "https://api.example/",
    pageUrl: "https://dashboard.example/?api=https://evil.example#token=bootstrap",
    storage: () => storage,
    replaceUrl: (url: string) => {
      expect(values.has("loopy-token:https://api.example")).toBe(false);
      cleaned = url;
    },
  };

  expect(browserConnection(options)).toEqual({
    baseUrl: "https://api.example",
    token: "bootstrap",
  });
  expect(cleaned).not.toContain("bootstrap");
  expect(values.has("loopy-token")).toBe(false);
  expect(browserConnection({ ...options, pageUrl: cleaned })).toEqual({
    baseUrl: "https://api.example",
    token: "bootstrap",
  });
  expect(
    browserConnection({ ...options, baseUrl: "https://other.example", pageUrl: cleaned }).token,
  ).toBeNull();
  expect(
    browserConnection({ ...options, baseUrl: "https://api.example/other", pageUrl: cleaned }).token,
  ).toBeNull();
  let removed = false;
  expect(
    browserConnection({
      ...options,
      storage: () => {
        throw new Error("Blocked");
      },
      replaceUrl() {
        removed = true;
      },
    }).token,
  ).toBe("bootstrap");
  expect(removed).toBe(true);
});
