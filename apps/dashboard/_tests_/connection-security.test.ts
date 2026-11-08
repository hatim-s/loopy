import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { makeLocalService } from "@loopy/runtime/local";
import { openRunStore } from "@loopy/runtime/store";
import { Effect } from "effect";
import { qualityTestRoot } from "../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { onCleanup, runScoped } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { originSecurity } from "../../../packages/runtime/src/local/server/security";
import {
  createRequestHandler,
  startServer,
} from "../../../packages/runtime/src/local/server/start-server";
import { localHttpBackend } from "../src/backend/local-http";
import { checkAccess } from "../src/session/access";

async function fixture() {
  const root = qualityTestRoot("connection");
  const home = join(root, "home");
  const store = await runScoped(openRunStore(home));

  const service = makeLocalService({
    store,
    home,
    clock: { now: Date.now },
  });

  return {
    store,
    service,
    cwd: root,
    assets: join(root, "assets"),
    port: 0,
    token: "isolated-test-token",
    daemon: { pid: process.pid, startedAt: new Date(0).toISOString(), concurrency: 1 },
  };
}

async function launch(allowedOrigins?: string[]) {
  const options = await fixture();
  const server = startServer({ ...options, allowedOrigins });
  onCleanup(() => server.stop());

  return { ...options, baseUrl: new URL(server.url).origin };
}

test("remote adapter authenticates against an isolated real server with explicit browser policy", async () => {
  const f = await launch(["https://dashboard.example"]);
  const fetchRequest = globalThis.fetch;
  const calls: RequestInit[] = [];

  const observed = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (init) {
          calls.push(init);
        }

        return fetchRequest(input, init);
      },
      { preconnect: fetchRequest.preconnect },
    ),
  );

  try {
    const backend = localHttpBackend({ baseUrl: f.baseUrl, token: f.token });
    expect(await backend.call("cursor", {}, AbortSignal.timeout(1000))).toMatchObject({
      cursor: 0,
      epoch: expect.any(String),
    });
    expect(calls[0]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    await expect(
      localHttpBackend({ baseUrl: f.baseUrl, token: null }).call(
        "cursor",
        {},
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      localHttpBackend({ baseUrl: f.baseUrl, token: "wrong" }).call(
        "cursor",
        {},
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  } finally {
    observed.mockRestore();
  }

  const request = (origin: string, token = f.token) =>
    fetch(`${f.baseUrl}/api/cursor`, {
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });

  const allowed = await request("https://dashboard.example");
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("access-control-allow-origin")).toBe("https://dashboard.example");
  expect(allowed.headers.get("vary")).toContain("Origin");
  expect(allowed.headers.has("access-control-allow-credentials")).toBe(false);
  const unauthorized = await request("https://dashboard.example", "wrong");
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("access-control-allow-origin")).toBe("https://dashboard.example");

  for (const origin of ["https://evil.example", "null", "https://dashboard.example.evil.example"]) {
    const rejected = await request(origin);
    expect(rejected.status).toBe(403);
    expect(rejected.headers.has("access-control-allow-origin")).toBe(false);
  }

  expect((await request(f.baseUrl)).status).toBe(200);
  const epoch = await Effect.runPromise(f.store.epoch());
  const controller = new AbortController();

  const stream = await fetch(`${f.baseUrl}/api/events?after=0&epoch=${epoch}`, {
    headers: { Origin: "https://dashboard.example", Authorization: `Bearer ${f.token}` },
    signal: controller.signal,
  });

  expect(stream.status).toBe(200);
  expect(stream.headers.get("access-control-allow-origin")).toBe("https://dashboard.example");
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  controller.abort();
  await expect(
    localHttpBackend({ baseUrl: f.baseUrl, token: f.token }).call("cancelRun", {
      params: { id: "missing" },
    }),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("preflight needs an allowed origin, method and headers but never bypasses actual auth", async () => {
  const f = await launch(["https://dashboard.example"]);

  const preflight = (origin: string, method = "POST", headers = "authorization, content-type") =>
    fetch(`${f.baseUrl}/api/runs`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": headers,
      },
    });

  const response = await preflight("https://dashboard.example");
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  expect(response.headers.get("vary")).toContain("Access-Control-Request-Headers");
  expect((await preflight("https://evil.example")).status).toBe(403);
  expect((await preflight("https://dashboard.example", "TRACE")).status).toBe(403);
  expect((await preflight("https://dashboard.example", "GET", "x-forwarded-host")).status).toBe(
    403,
  );
  expect(
    (await fetch(`${f.baseUrl}/api/runs`, { headers: { Origin: "https://dashboard.example" } }))
      .status,
  ).toBe(401);
  const local = await launch();
  expect(
    (
      await fetch(`${local.baseUrl}/api/cursor`, {
        headers: { Origin: "https://dashboard.example", Authorization: `Bearer ${local.token}` },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${local.baseUrl}/api/cursor`, {
        headers: { Host: "evil.example", Authorization: `Bearer ${local.token}` },
      })
    ).status,
  ).toBe(403);
});

test("public host handler uses its configured origin without trusting forwarded hosts", async () => {
  const options = await fixture();

  const handler = createRequestHandler({
    ...options,
    publicOrigin: "https://api.example",
    allowedOrigins: ["https://dashboard.example"],
  });

  const headers = {
    Host: "api.example",
    Origin: "https://dashboard.example",
    Authorization: `Bearer ${options.token}`,
  };

  expect((await handler(new Request("https://api.example/api/cursor", { headers }))).status).toBe(
    200,
  );
  expect((await handler(new Request("https://evil.example/api/cursor", { headers }))).status).toBe(
    403,
  );
  expect(
    (
      await handler(
        new Request("https://api.example/api/cursor", {
          headers: { ...headers, Host: "evil.example", "X-Forwarded-Host": "api.example" },
        }),
      )
    ).status,
  ).toBe(403);

  for (const origin of [
    "*",
    "null",
    "https://*.example",
    "https://api.example/path",
    "https://user:pass@api.example",
    "https://api.example?query=1",
  ]) {
    expect(() => originSecurity({ publicOrigin: origin })).toThrow();
    expect(() =>
      originSecurity({ publicOrigin: "https://api.example", allowedOrigins: [origin] }),
    ).toThrow();
  }
});

test("access gate opens only for the current token and sends nothing without one", async () => {
  const f = await launch();

  const access = (token: string | null, baseUrl = f.baseUrl) =>
    checkAccess(localHttpBackend({ baseUrl, token }), token);

  expect(await access(f.token)).toBe("open");
  expect(await access("token-from-a-previous-daemon")).toBe("rejected");
  const fetches = spyOn(globalThis, "fetch");

  try {
    expect(await access(null)).toBe("missing");
    expect(fetches).not.toHaveBeenCalled();
  } finally {
    fetches.mockRestore();
  }

  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  await closed.stop(true);
  expect(await access(f.token, closed.url.origin)).toBe("unreachable");
});
