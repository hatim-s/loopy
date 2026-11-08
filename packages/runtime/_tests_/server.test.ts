import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cursorViewSchema,
  daemonViewSchema,
  decodeBoundary,
  decodeEventBatch,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
  errorBodySchema,
  type Json,
  runSnapshotViewSchema,
  runViewSchema,
  scheduleViewSchema,
  splitSseFrames,
} from "@loopy/contract";
import { log, loopy } from "@loopy/sdk";
import { Effect, Scope } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { localDaemon, readDaemonFile, ServiceError } from "../src/local";
import { serveHttp } from "./fixtures/http-server";
import { fixture, object, runFixture, save } from "./fixtures/project";
import { daemonToken, serviceFixture } from "./fixtures/server";
import { fixtureStore } from "./fixtures/service-runtime";
import { fixtureScope, onCleanup } from "./fixtures/test-scope";

async function startDaemon(options: { home: string; cwd: string; port: number; assets?: string }) {
  const store = await fixtureStore(options.home);

  const daemon = await Effect.runPromise(
    localDaemon({ concurrency: 4, assets: join(options.cwd, "assets"), ...options, store }).pipe(
      Effect.provideService(Scope.Scope, fixtureScope()),
    ),
  );

  onCleanup(async () => {
    await Effect.runPromise(daemon.stop);
    await Effect.runPromise(store.close());
  });

  return { url: await Effect.runPromise(daemon.start) };
}

test("API returns run records, step traces and cursor logs", async () => {
  const f = fixture(
    loopy("api", {
      input: {},
      run: () => {
        log("first");
        log("second");

        return 2;
      },
    }),
  );

  await save(f);
  const run = await runFixture(f);
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  const url = new URL(server.url);
  const token = daemonToken(url);
  const headers = { Authorization: `Bearer ${token}` };
  const request = (path: string) => fetch(`${url.origin}/api${path}`, { headers });
  expect(await (await request(`/runs/${run.id}`)).json()).toMatchObject({
    nodeRuns: [{ status: "succeeded" }, { status: "succeeded" }, { status: "succeeded" }],
  });
  expect(await (await request(`/runs/${run.id}/logs`)).json()).toMatchObject([
    { message: "first" },
    { message: "second" },
  ]);
  expect(await (await request(`/runs/${run.id}/logs?after=1`)).json()).toMatchObject([
    { message: "second" },
  ]);
  expect((await request(`/runs/${run.id}/logs?after=-1`)).status).toBe(400);
  expect((await request("/runs/missing/logs")).status).toBe(404);
  expect(await (await request("/runs")).json()).toMatchObject([{ id: run.id }]);
});

test("the daemon server requires its token and origin, serves pinned assets and serves authenticated API reads", async () => {
  const f = fixture(loopy("dashboard", { input: {}, run: () => 1 }));
  await save(f);
  const assets = join(f.cwd, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "original dashboard");
  const server = await startDaemon({ home: f.home, cwd: f.cwd, assets, port: 0 });
  const url = new URL(server.url);
  const token = daemonToken(url);
  const headers = { Authorization: `Bearer ${token}` };

  const rejections: [HeadersInit, number, ErrorCode][] = [
    [{}, 401, "unauthorized"],
    [{ Authorization: "Bearer wrong" }, 401, "unauthorized"],
    [{ ...headers, Origin: "https://other.example" }, 403, "forbidden"],
    [{ ...headers, Host: "evil.example" }, 403, "forbidden"],
  ];

  for (const [headers, status, code] of rejections) {
    const response = await fetch(`${url.origin}/api/runs`, { headers });
    expect(response.status).toBe(status);
    expect(decodeBoundary(errorBodySchema)(await response.json()).error.code).toBe(code);
  }

  const own = await fetch(`${url.origin}/api/runs`, {
    headers: { ...headers, Origin: url.origin },
  });

  expect(own.status).toBe(200);
  expect(own.headers.has("access-control-allow-origin")).toBe(false);

  expect(await (await fetch(`${url.origin}/api/loopies`, { headers })).json()).toMatchObject([
    { slug: "dashboard" },
  ]);
  expect((await fetch(`${url.origin}/api/runs`, { method: "POST", headers })).status).toBe(404);
  writeFileSync(join(assets, "index.html"), "changed dashboard");
  const page = await fetch(url.origin);
  expect(await page.text()).toBe("original dashboard");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("API distinguishes invalid cursors from registry failures", async () => {
  const f = fixture(loopy("server-errors", { input: {}, run: () => 1 }));
  await save(f);
  const run = await runFixture(f);
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  const url = new URL(server.url);
  const token = daemonToken(url);
  const headers = { Authorization: `Bearer ${token}` };

  for (const path of [`/api/runs/${run.id}/logs?after=bad`, "/api/runs?limit=300"]) {
    const response = await fetch(`${url.origin}${path}`, { headers });
    expect(response.status).toBe(400);
    expect(decodeBoundary(errorBodySchema)(await response.json()).error.code).toBe("bad_request");
  }

  writeFileSync(join(f.cwd, ".loopy", "loopies", "server-errors.json"), "invalid JSON");
  const failed = await fetch(`${url.origin}/api/loopies`, { headers });
  expect(failed.status).toBe(500);
  expect(decodeBoundary(errorBodySchema)(await failed.json()).error.code).toBe("internal");
  expect((await fetch(`${url.origin}/api/config`, { headers })).status).toBe(404);
});

test("API returns the contract snapshot, rejects unknown query keys and keeps cursor log reads", async () => {
  const f = fixture(
    loopy("summary", {
      input: {},
      run: () => {
        log("hello");

        return 1;
      },
    }),
  );

  await save(f);
  const run = await runFixture(f);
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  const url = new URL(server.url);
  const token = daemonToken(url);
  const headers = { Authorization: `Bearer ${token}` };
  const path = `${url.origin}/api/runs/${run.id}`;
  const full = object(await (await fetch(path, { headers })).text());
  expect(full.nodeRuns).toHaveLength(2);
  expect(await (await fetch(`${path}/logs?after=0`, { headers })).json()).toMatchObject([
    { message: "hello" },
  ]);
  expect(await (await fetch(`${path}/logs?after=1`, { headers })).json()).toEqual([]);
  expect((await fetch(`${url.origin}/api/runs/missing`, { headers })).status).toBe(404);
});

test("contract routes start, snapshot, resume and cancel without exposing owner tokens", async () => {
  const f = fixture(loopy("contract", { input: {}, run: () => null }));
  await save(f);
  const initialStore = await fixtureStore(f.home);
  await Effect.runPromise(
    initialStore.createRun({ ...newRun(), id: "initial", slug: "contract", workspace: f.cwd }),
  );
  await Effect.runPromise(initialStore.close());
  const initial = { id: "initial" };
  const server = await startDaemon({ ...f, port: 0 });
  const url = new URL(server.url);

  const headers = {
    Authorization: `Bearer ${daemonToken(url)}`,
    "Content-Type": "application/json",
  };

  const request = (path: string, body: Json | undefined = undefined) =>
    fetch(`${url.origin}/api${path}`, {
      headers,
      method: body === undefined ? "GET" : "POST",
      body: body === null ? undefined : JSON.stringify(body),
    });

  const snapshot = decodeBoundary(runSnapshotViewSchema)(
    await (await request(`/runs/${initial.id}`)).json(),
  );

  expect(snapshot.run.waitingOn).toBeNull();
  expect(JSON.stringify(snapshot)).not.toContain('"owner":{"token"');
  expect(snapshot.run.owner).toBeNull();

  const started = decodeBoundary(runViewSchema)(
    await (await request("/loopies/contract/runs", { input: {}, workspace: f.cwd })).json(),
  );

  expect(started.status).toBe("queued");
  expect((await request(`/runs/${started.id}/resume`, null)).status).toBe(200);
  expect(
    decodeBoundary(runViewSchema)(await (await request(`/runs/${started.id}/cancel`, null)).json())
      .status,
  ).toBe("cancelled");
  expect((await request(`/runs/${started.id}/cancel`, null)).status).toBe(409);
  expect((await request("/runs/missing/resume", null)).status).toBe(404);
  expect((await request("/loopies/contract/runs", {})).status).toBe(400);
  expect(decodeBoundary(daemonViewSchema)(await (await request("/daemon")).json()).pid).toBe(
    process.pid,
  );
  const store = await fixtureStore(f.home);

  try {
    await Effect.runPromise(store.claim(String(initial.id), "private-fencing-token"));
    const owned = await (await request(`/runs/${initial.id}`)).text();
    expect(owned).not.toContain("private-fencing-token");
    expect((await request(`/runs/${initial.id}/cancel`, null)).status).toBe(409);
  } finally {
    await Effect.runPromise(store.close());
  }
});

test("SPA routes fall back to pinned index but missing files stay 404", async () => {
  const f = fixture(loopy("spa", { input: {}, run: () => 1 }));
  await save(f);
  const assets = join(f.cwd, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "SPA");
  const server = await startDaemon({ ...f, port: 0, assets });
  const origin = new URL(server.url).origin;
  expect(await (await fetch(`${origin}/runs/some-run`)).text()).toBe("SPA");
  expect((await fetch(`${origin}/missing.js`)).status).toBe(404);
  expect((await fetch(`${origin}/api/missing`)).status).toBe(401);
  const headers = { Authorization: `Bearer ${readDaemonFile(f.home)!.token}` };
  const bare = await fetch(`${origin}/api`, { headers });
  expect(bare.status).toBe(404);
  expect(decodeBoundary(errorBodySchema)(await bare.json()).error.code).toBe("not_found");
  expect((await fetch(`${origin}/`, { headers: { Host: "evil.example" } })).status).toBe(403);
});

test("native definition routes return 404 for absence and 500 for corrupt saved data", async () => {
  const f = fixture(loopy("corrupt-definition", { input: {}, run: () => 1 }));
  await save(f);
  writeFileSync(join(f.cwd, ".loopy", "loopies", "corrupt-definition.json"), "{invalid");
  const server = await startDaemon({ ...f, port: 0 });
  const origin = new URL(server.url).origin;
  const headers = { Authorization: `Bearer ${readDaemonFile(f.home)!.token}` };

  for (const slug of ["absent", "corrupt-definition"]) {
    for (const [method, suffix, body] of [
      ["POST", "runs", { input: {} }],
      ["GET", "graph", undefined],
      ["GET", "source", undefined],
      ["PUT", "schedule", { cron: "* * * * *" }],
      ["POST", "schedule/enabled", { enabled: true }],
      ["DELETE", "schedule", undefined],
    ] as const) {
      const response = await fetch(`${origin}/api/loopies/${slug}/${suffix}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const error = decodeBoundary(errorBodySchema)(await response.json()).error;
      expect(response.status).toBe(slug === "absent" ? 404 : 500);
      expect(error.code).toBe(slug === "absent" ? "not_found" : "internal");

      if (slug === "absent") {
        expect(error.message).toBe("No saved loopy 'absent'. Use loopy save <file.ts> first.");
      }
    }
  }
});

test("response validation rejects a view with extra fields", async () => {
  const { f, store, service } = await serviceFixture("leak");

  const leaking = (await Effect.runPromise(service.listLoopies(f.cwd))).map((loopy) => ({
    ...loopy,
    secrets: ["private"],
  }));

  const list = spyOn(service, "listLoopies").mockReturnValue(Effect.succeed(leaking));
  const { request, causes } = serveHttp({ service, store, cwd: f.cwd });

  try {
    const response = await request("/loopies");

    expect(response.status).toBe(500);
    expect(causes).toHaveLength(1);
  } finally {
    list.mockRestore();
    await Effect.runPromise(store.close());
  }
});

test("service error codes serialize with their HTTP status", async () => {
  const { f, store, service } = await serviceFixture("errors");
  const { request } = serveHttp({ service, store, cwd: f.cwd });
  const snapshot = spyOn(service, "runSnapshot");

  try {
    for (const code of ERROR_CODES) {
      snapshot.mockReturnValue(Effect.fail(new ServiceError(code)));
      const response = await request("/runs/run");
      expect(response.status).toBe(ERROR_STATUS[code]);
      expect(decodeBoundary(errorBodySchema)(await response.json()).error.code).toBe(code);
    }
  } finally {
    snapshot.mockRestore();
    await Effect.runPromise(store.close());
  }
});

async function scheduleApi() {
  const { f, store, service } = await serviceFixture("schedule-api");
  const http = serveHttp({ service, store, cwd: f.cwd });

  const request = (path: string, method = "GET", body?: Json) =>
    http.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  return { store, request };
}

test("schedule routes round trip validated views and report status codes", async () => {
  const { store, request } = await scheduleApi();
  const path = "/loopies/schedule-api/schedule";

  try {
    expect(await (await request("/schedules")).json()).toEqual([]);
    const response = await request(path, "PUT", { cron: "* * * * *" });
    expect(response.status).toBe(200);
    const saved = decodeBoundary(scheduleViewSchema)(await response.json());
    expect(saved).toMatchObject({ slug: "schedule-api", enabled: true, lastFireKey: null });
    expect(await (await request("/schedules")).json()).toEqual([saved]);
    expect(
      await (await request(`${path}/enabled`, "POST", { enabled: false })).json(),
    ).toMatchObject({ enabled: false });

    const invalidBodies: {
      body: Json;
      code: ErrorCode;
    }[] = [
      { body: { cron: "invalid" }, code: "invalid_cron" },
      { body: { cron: "* * * * *", tz: "Bad/Zone" }, code: "invalid_timezone" },
      { body: {}, code: "invalid_schedule" },
    ];

    for (const { body, code } of invalidBodies) {
      const invalid = await request(path, "PUT", body);
      expect(invalid.status).toBe(400);
      expect(decodeBoundary(errorBodySchema)(await invalid.json()).error.code).toBe(code);
    }

    const malformed = await request(path, "PUT", { enabled: "no" });
    expect(malformed.status).toBe(400);
    expect(decodeBoundary(errorBodySchema)(await malformed.json()).error.code).toBe("bad_request");
    expect((await request("/loopies/missing/schedule", "PUT", {})).status).toBe(404);
    expect(await (await request(path, "DELETE")).json()).toEqual({ deleted: true });
    expect((await request(`${path}/enabled`, "POST", { enabled: true })).status).toBe(404);
  } finally {
    await Effect.runPromise(store.close());
  }
});

test("schedule PUT publishes a saved SSE frame", async () => {
  const { store, request } = await scheduleApi();
  const stream = await request(`/events?after=0&epoch=${await Effect.runPromise(store.epoch())}`);
  const reader = stream.body!.getReader();

  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    expect(
      (await request("/loopies/schedule-api/schedule", "PUT", { cron: "* * * * *" })).status,
    ).toBe(200);
    const [frame] = splitSseFrames(new TextDecoder().decode((await reader.read()).value)).frames;
    expect(frame).toBeDefined();
    expect(decodeEventBatch(frame!.data)).toMatchObject([
      { entity: "schedule", kind: "saved", record: { slug: "schedule-api", cron: "* * * * *" } },
    ]);
  } finally {
    await reader.cancel();
    await Effect.runPromise(store.close());
  }
});

test("cursor endpoint bootstraps an empty dashboard and follows new events", async () => {
  const f = fixture(loopy("cursor", { input: {}, run: () => 1 }));
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  const url = new URL(server.url);
  const token = daemonToken(url);
  const headers = { Authorization: `Bearer ${token}` };
  const request = () => fetch(`${url.origin}/api/cursor`, { headers });
  const response = await request();
  expect(response.status).toBe(200);
  const initial = decodeBoundary(cursorViewSchema)(await response.json());
  expect(initial.cursor).toBe(0);
  expect(initial.epoch).toBeString();
  const store = await fixtureStore(f.home);

  try {
    await Effect.runPromise(store.createRun(newRun()));
    const current = decodeBoundary(cursorViewSchema)(await (await request()).json());
    expect(current).toEqual({ cursor: 1, epoch: initial.epoch });
    expect(current).toEqual(await Effect.runPromise(store.eventCursor()));
  } finally {
    await Effect.runPromise(store.close());
  }
});
