import { afterEach, expect, test } from "bun:test";
import { localHttpBackend } from "../src/backend/local-http";
import { bootSession, httpBaseUrl } from "../src/session/boot";

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
      localHttpBackend({ baseUrl: source.url.origin, token: "isolated" }).call(
        "cursor",
        {},
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
  await localHttpBackend({
    baseUrl: httpBaseUrl(`${server.url.origin}/loopy/`),
    token: null,
  }).call("cursor", {}, AbortSignal.timeout(1000));
  expect(path).toBe("/loopy/api/cursor");
  const backend = localHttpBackend({ baseUrl: server.url.origin, token: null });
  await expect(backend.call("log", { params: { id: 17 } })).rejects.toMatchObject({
    code: "malformed_response",
  });
  expect(path).toBe("/api/logs/17");
  await expect(backend.call("event", { params: { sequence: 23 } })).rejects.toMatchObject({
    code: "malformed_response",
  });
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
  const values = new Map<string, string>();

  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };

  const replaced: { url: string; storedBefore: boolean }[] = [];

  const options = {
    baseUrl: "https://api.example/",
    pageUrl: "https://dashboard.example/?api=https://evil.example#token=bootstrap",
    storage: () => storage,
    replaceUrl: (url: string) => {
      replaced.push({ url, storedBefore: values.has("loopy-token:https://api.example") });
    },
  };

  expect(bootSession(options)).toEqual({ baseUrl: "https://api.example", token: "bootstrap" });

  const [cleaned] = replaced;

  expect(cleaned?.storedBefore).toBe(false);
  expect(cleaned?.url).not.toContain("bootstrap");

  const later = { ...options, pageUrl: cleaned?.url ?? "" };

  expect(bootSession(later)).toEqual({ baseUrl: "https://api.example", token: "bootstrap" });
  expect(bootSession({ ...later, baseUrl: "https://other.example" }).token).toBeNull();
  expect(bootSession({ ...later, baseUrl: "https://api.example/other" }).token).toBeNull();

  const blocked = bootSession({
    ...options,
    storage: () => {
      throw new Error("Blocked");
    },
  });

  expect(blocked.token).toBe("bootstrap");
  expect(replaced).toHaveLength(2);
});
