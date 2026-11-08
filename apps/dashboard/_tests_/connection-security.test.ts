import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { makeLocalService } from "@loopy/runtime/local";
import { openRunStore } from "@loopy/runtime/store";
import { qualityTestRoot } from "../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { onCleanup, runScoped } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { startServer } from "../../../packages/runtime/src/local/server/start-server";
import { localHttpBackend } from "../src/backend/local-http";
import { checkAccess } from "../src/session/access";

async function fixture() {
  const root = qualityTestRoot("connection");
  const home = join(root, "home");
  const store = await runScoped(openRunStore(home));

  const service = makeLocalService({
    store,
    home,
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

test("remote adapter sends no credentials and maps server auth and missing-run errors", async () => {
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

  await expect(
    localHttpBackend({ baseUrl: f.baseUrl, token: f.token }).call("cancelRun", {
      params: { id: "missing" },
    }),
  ).rejects.toMatchObject({ code: "not_found" });
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
