import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonViewSchema,
  type ErrorCode,
  encodeRunCursor,
  errorBodySchema,
  type Json,
  runSnapshotViewSchema,
  runsQuerySchema,
  runViewSchema,
  serverEventSchema,
} from "../src/contract/index.js";
import { requireRecord } from "../src/core/index.js";
import {
  LoopyService,
  localDaemon,
  openRunStore,
  Registry,
  readDaemonFile,
  ServiceError,
} from "../src/local/index.js";
import { eventStream } from "../src/local/server/events.js";
import { apiRoutes, dispatch } from "../src/local/server/routes.js";
import { SYSTEM_CLOCK } from "../src/runtime/index.js";

const roots: string[] = [];

const servers: ReturnType<typeof startServer>[] = [];

const CLI = resolve(import.meta.dir, "../src/cli/index.ts");

const SDK = resolve(import.meta.dir, "../src/sdk/index.ts");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(name: string, definition: string) {
  const root = mkdtempSync(join(tmpdir(), "loopy-cli-sdk-"));
  roots.push(root);
  const home = join(root, "home");
  const file = join(root, `${name}.loopy.ts`);
  writeFileSync(
    file,
    `import { loopy, step, sleep, hook, command } from ${JSON.stringify(SDK)};
export default loopy({ name: ${JSON.stringify(name)}, ${definition} });`,
  );

  return { cwd: root, home, file };
}

async function cli(f: ReturnType<typeof fixture>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, "--home", f.home, ...args], {
    cwd: f.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}

function object(text: string) {
  return requireRecord(JSON.parse(text), "CLI output");
}

async function save(f: ReturnType<typeof fixture>) {
  const result = await cli(f, "save", f.file);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);

  return object(result.stdout);
}

function startServer(options: { home: string; cwd: string; port: number; assets?: string }) {
  const store = openRunStore(options.home);
  const daemon = localDaemon({ ...options, store });

  return {
    url: daemon.start(),
    async stop() {
      await daemon.stop();
      store.close();
    },
  };
}

test("API returns run records, step traces and cursor logs", async () => {
  const f = fixture(
    "api",
    `run: async ({ log }) => { log.info("first"); await step("one", () => 1); log.info("second"); return 2; }`,
  );

  await save(f);
  const run = object((await cli(f, "run", "api")).stdout);
  const server = startServer({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const request = (path: string) => fetch(`${url.origin}/api${path}`, { headers });
  const detail = requireRecord(await (await request(`/runs/${run.id}`)).json(), "Run detail");
  expect(detail.steps).toMatchObject([{ key: "one", status: "succeeded" }]);
  expect(detail.logs).toMatchObject([{ message: "first" }, { message: "second" }]);
  expect(await (await request(`/runs/${run.id}/logs?after=1`)).json()).toMatchObject([
    { message: "second" },
  ]);
  expect((await request(`/runs/${run.id}/logs?after=-1`)).status).toBe(400);
  expect((await request("/runs/missing/logs")).status).toBe(404);
  expect(await (await request("/runs")).json()).toMatchObject([{ id: run.id }]);
});

test("Studio requires its token and origin, serves pinned assets and exposes read-only data", async () => {
  const f = fixture("studio", "run: () => 1");
  await save(f);
  const assets = join(f.cwd, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "original Studio");
  const server = startServer({ home: f.home, cwd: f.cwd, assets, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  expect((await fetch(`${url.origin}/api/runs`)).status).toBe(401);
  expect(
    (await fetch(`${url.origin}/api/runs`, { headers: { Authorization: "Bearer wrong" } })).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${url.origin}/api/runs`, {
        headers: { ...headers, Origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  expect(await (await fetch(`${url.origin}/api/loopies`, { headers })).json()).toMatchObject([
    { slug: "studio" },
  ]);
  expect((await fetch(`${url.origin}/api/runs`, { method: "POST", headers })).status).toBe(404);
  writeFileSync(join(assets, "index.html"), "changed Studio");
  const page = await fetch(url.origin);
  expect(await page.text()).toBe("original Studio");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("API distinguishes invalid cursors from registry failures", async () => {
  const f = fixture("server-errors", "run: () => 1");
  await save(f);
  const run = object((await cli(f, "run", "server-errors")).stdout);
  const server = startServer({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  expect((await fetch(`${url.origin}/api/runs/${run.id}/logs?after=bad`, { headers })).status).toBe(
    400,
  );
  writeFileSync(join(f.cwd, ".loopy", "loopies", "server-errors.json"), "invalid JSON");
  expect((await fetch(`${url.origin}/api/loopies`, { headers })).status).toBe(500);
  expect((await fetch(`${url.origin}/api/config`, { headers })).status).toBe(404);
});

test("API returns the contract snapshot, rejects unknown query keys and keeps cursor log reads", async () => {
  const f = fixture(
    "summary",
    'run: ({ log }) => step("work", () => { log.info("hello"); return 1; })',
  );

  await save(f);
  const run = object((await cli(f, "run", "summary")).stdout);
  const server = startServer({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const path = `${url.origin}/api/runs/${run.id}`;
  const full = object(await (await fetch(path, { headers })).text());
  expect(full.steps).toHaveLength(1);
  expect(full.logs).toHaveLength(1);
  // The old viewer's logs=false switch is gone; strict query parsing rejects it.
  expect((await fetch(`${path}?logs=false`, { headers })).status).toBe(400);
  expect(await (await fetch(`${path}/logs?after=0`, { headers })).json()).toEqual(full.logs);
  expect(await (await fetch(`${path}/logs?after=1`, { headers })).json()).toEqual([]);
  expect((await fetch(`${url.origin}/api/runs/missing`, { headers })).status).toBe(404);
});

test("hook API applies auth and origin checks and resolves JSON exactly once", async () => {
  const f = fixture("api-hook", `run: async () => hook("approve")`);
  await save(f);
  const run = object((await cli(f, "run", "api-hook")).stdout);
  const store = openRunStore(f.home);
  const [hook] = await store.listHooks(String(run.id));
  store.close();
  const server = startServer({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const endpoint = `${url.origin}/api/hooks/${hook?.token}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const post = (body: string, requestHeaders: Record<string, string> = headers) =>
    fetch(endpoint, { method: "POST", headers: requestHeaders, body });

  expect((await post("{}", { ...headers, Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await post("{}", { ...headers, Origin: "https://untrusted.example" })).status).toBe(403);
  expect((await post("invalid")).status).toBe(400);
  expect(await (await post('{"payload":{"ok":true}}')).json()).toMatchObject({
    id: run.id,
    status: "suspended",
  });
  expect((await post('{"payload":null}')).status).toBe(404);
});

test("contract routes start, snapshot, resume and cancel without exposing owner tokens", async () => {
  const f = fixture("contract", 'run: async () => hook("approve")');
  await save(f);
  const initial = object((await cli(f, "run", "contract")).stdout);
  const server = startServer({ ...f, port: 0 });
  servers.push(server);
  const url = new URL(server.url);

  const headers = {
    Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
    "Content-Type": "application/json",
  };

  const request = (path: string, body: Json | undefined = undefined) =>
    fetch(`${url.origin}/api${path}`, {
      headers,
      method: body === undefined ? "GET" : "POST",
      body: body === null ? undefined : JSON.stringify(body),
    });

  const snapshot = runSnapshotViewSchema.parse(await (await request(`/runs/${initial.id}`)).json());
  expect(snapshot.run.waitingOn).toMatchObject({ hook: "approve" });
  expect(JSON.stringify(snapshot)).not.toContain('"owner":{"token"');
  expect(snapshot.run.owner).toBeNull();

  const started = runViewSchema.parse(
    await (await request("/loopies/contract/runs", { input: {}, workspace: f.cwd })).json(),
  );

  expect(started.status).toBe("queued");
  expect((await request(`/runs/${started.id}/resume`, null)).status).toBe(200);
  expect(
    runViewSchema.parse(await (await request(`/runs/${started.id}/cancel`, null)).json()).status,
  ).toBe("cancelled");
  expect((await request(`/runs/${started.id}/cancel`, null)).status).toBe(409);
  expect((await request("/runs/missing/resume", null)).status).toBe(404);
  expect((await request("/loopies/contract/runs", {})).status).toBe(400);
  expect(daemonViewSchema.parse(await (await request("/daemon")).json()).pid).toBe(process.pid);
  const store = openRunStore(f.home);

  try {
    await store.claim(String(initial.id), "private-fencing-token");
    const owned = await (await request(`/runs/${initial.id}`)).text();
    expect(owned).not.toContain("private-fencing-token");
    expect((await request(`/runs/${initial.id}/cancel`, null)).status).toBe(409);
  } finally {
    store.close();
  }
});

test("SPA routes fall back to pinned index but missing files stay 404", async () => {
  const f = fixture("spa", "run: () => 1");
  await save(f);
  const assets = join(f.cwd, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "SPA");
  const server = startServer({ ...f, port: 0, assets });
  servers.push(server);
  const origin = new URL(server.url).origin;
  expect(await (await fetch(`${origin}/runs/some-run`)).text()).toBe("SPA");
  expect((await fetch(`${origin}/missing.js`)).status).toBe(404);
  expect((await fetch(`${origin}/api/missing`)).status).toBe(401);
  const headers = { Authorization: `Bearer ${readDaemonFile(f.home)!.token}` };
  const bare = await fetch(`${origin}/api`, { headers });
  expect(bare.status).toBe(404);
  expect(errorBodySchema.parse(await bare.json()).error.code).toBe("not_found");
  expect((await fetch(`${origin}/`, { headers: { Host: "evil.example" } })).status).toBe(403);
});

async function serviceFixture(name: string) {
  const f = fixture(name, "run: () => 1");
  await save(f);
  const store = openRunStore(f.home);

  const service = new LoopyService({
    home: f.home,
    store,
    registry: () => new Registry(f.home, f.cwd),
    clock: SYSTEM_CLOCK,
  });

  return { f, store, service };
}

function parseFrame(lines: string[]) {
  const data = lines
    .flatMap((line) => (line.startsWith("data: ") ? [line.slice(6)] : []))
    .join("\n");

  if (!data) {
    return undefined;
  }

  const events = serverEventSchema.array().parse(JSON.parse(data));

  return {
    id: Number(lines.find((line) => line.startsWith("id: "))?.slice(4)),
    sequences: events.map((event) => event.sequence),
    transactions: [...new Set(events.map((event) => event.txn))],
  };
}

function fragment(body: ReadableStream<Uint8Array>) {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (let offset = 0; offset < chunk.byteLength; offset += 7) {
          controller.enqueue(chunk.slice(offset, offset + 7));
        }
      },
    }),
  );
}

function captureFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: { id: number; sequences: number[]; transactions: string[] }[] = [];
  let buffer = "";

  const reading = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += decoder.decode(chunk.value, { stream: true });

      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const lines = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);

        const frame = parseFrame(lines);

        if (frame) {
          frames.push(frame);
        }
      }
    }
  })();

  return {
    frames,
    async finish() {
      await Bun.sleep(250);
      await reader.cancel();
      await reading;
      expect(buffer).toBe("");

      return frames;
    },
  };
}

function expectedFrames(events: Awaited<ReturnType<ReturnType<typeof openRunStore>["events"]>>) {
  const frames: { id: number; sequences: number[]; transactions: string[] }[] = [];

  for (const event of events) {
    const last = frames.at(-1);

    if (last?.transactions[0] === event.txn) {
      last.id = event.sequence;
      last.sequences.push(event.sequence);
    } else {
      frames.push({ id: event.sequence, sequences: [event.sequence], transactions: [event.txn] });
    }
  }

  return frames;
}

async function externalRun(
  home: string,
  run: Parameters<ReturnType<typeof openRunStore>["createRun"]>[0],
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openRunStore } from ${JSON.stringify(resolve(import.meta.dir, "../src/local/index.ts"))}; const store = openRunStore(process.argv[1]); await store.createRun(JSON.parse(process.argv[2])); store.close();`,
      home,
      JSON.stringify(run),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  expect(await child.exited).toBe(0);
}

function replayRun(workspace: string) {
  return {
    id: "replay",
    slug: "events",
    workspace,
    bundleHash: "a".repeat(64),
    input: {},
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as const;
}

async function reconnectFrames(
  endpoint: string,
  headers: Record<string, string>,
  events: Awaited<ReturnType<ReturnType<typeof openRunStore>["events"]>>,
) {
  const cursor = events[0]!.sequence;

  const resumed = await fetch(endpoint, {
    headers: { ...headers, "Last-Event-ID": String(cursor) },
  });

  expect(await captureFrames(resumed.body!).finish()).toEqual(
    expectedFrames(events.filter((event) => event.sequence > cursor)),
  );
}

test("SSE delivers exact transactions across replay, cross-process writes and Last-Event-ID reconnect", async () => {
  const f = fixture("events", "run: () => 1");
  await save(f);
  const store = openRunStore(f.home);
  const daemon = localDaemon({ ...f, store, port: 0 });
  const url = new URL(daemon.start());

  const headers = {
    Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
  };

  const run = replayRun(f.cwd);

  try {
    await store.createRun(run);
    const endpoint = `${url.origin}/api/events?after=0&epoch=${await store.epoch()}`;
    expect((await fetch(`${url.origin}/api/events?after=0&epoch=wrong`, { headers })).status).toBe(
      410,
    );
    const response = await fetch(endpoint, { headers });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const capture = captureFrames(fragment(response.body!));

    await externalRun(f.home, { ...run, id: "external" });
    await store.claim(run.id, "owner");
    const events = await store.events(0, 100);
    expect(await capture.finish()).toEqual(expectedFrames(events));
    await reconnectFrames(endpoint, headers, events);
    await store.pruneEvents("2100-01-01T00:00:00.000Z");
    await store.createRun({ ...run, id: "retained" });
    expect((await fetch(endpoint, { headers })).status).toBe(410);
  } finally {
    await daemon.stop();
    store.close();
  }
});

test("SSE disconnect removes the subscriber and stops polling", async () => {
  const { store, service } = await serviceFixture("disconnect");

  let active = 0;
  const original = store.subscribe.bind(store);

  const subscribe = spyOn(store, "subscribe").mockImplementation((listener) => {
    active++;
    const unsubscribe = original(listener);

    return () => {
      active--;
      unsubscribe();
    };
  });

  const version = spyOn(store, "dataVersion");

  const response = await eventStream(
    store,
    service,
    { after: 0, epoch: await store.epoch() },
    new AbortController().signal,
  );

  const unsubscribe = subscribe.mock.results[0]?.value;
  expect(unsubscribe).toBeFunction();
  await response.body!.cancel();
  expect(active).toBe(0);
  const calls = version.mock.calls.length;
  await Bun.sleep(220);
  expect(version.mock.calls.length).toBe(calls);
  store.close();
  subscribe.mockRestore();
  version.mockRestore();
});

test("response validation rejects a view with extra fields", async () => {
  const { f, store, service } = await serviceFixture("leak");

  const leaking = (await service.listLoopies()).map((loopy) => ({
    ...loopy,
    secrets: ["private"],
  }));

  const list = spyOn(service, "listLoopies").mockResolvedValue(leaking);
  const request = new Request("http://127.0.0.1/api/loopies");

  try {
    await expect(
      dispatch(
        apiRoutes({ service, store, cwd: f.cwd }),
        request,
        new URL(request.url),
        "/api/loopies",
      ),
    ).rejects.toThrow("unrecognized_keys");
  } finally {
    list.mockRestore();
    store.close();
  }
});

test("service error codes serialize with their HTTP status", async () => {
  const { f, store, service } = await serviceFixture("errors");

  const request = new Request("http://127.0.0.1/api/runs");

  const cases: [ErrorCode, number][] = [
    ["not_found", 404],
    ["unknown_hook", 404],
    ["not_claimable", 409],
    ["owned_elsewhere", 409],
    ["bad_request", 400],
    ["stale_cursor", 410],
  ];

  const list = spyOn(service, "listRuns");

  try {
    for (const [code, status] of cases) {
      list.mockRejectedValue(new ServiceError(code));

      const response = await dispatch(
        apiRoutes({ service, store, cwd: f.cwd }),
        request,
        new URL(request.url),
        "/api/runs",
      );

      expect(response.status).toBe(status);
      expect(errorBodySchema.parse(await response.json()).error.code).toBe(code);
    }
  } finally {
    list.mockRestore();
    store.close();
  }
});

async function recoveryRun(store: ReturnType<typeof openRunStore>, workspace: string) {
  const run = {
    id: "batch",
    slug: "batch",
    workspace,
    bundleHash: "a".repeat(64),
    input: {},
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    owner: { token: "old", host: "another-host", pid: 1, heartbeatAt: new Date(0).toISOString() },
  } as const;

  await store.createRun(run);

  for (let seq = 0; seq < 505; seq++) {
    await store.putStep(run.id, "old", {
      runId: run.id,
      seq,
      key: `step-${seq}`,
      kind: "function",
      input: null,
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: run.createdAt,
    });
  }

  return run;
}

test("SSE keeps a recovery transaction whole across the replay batch limit", async () => {
  const { f, store, service } = await serviceFixture("batch");

  try {
    const run = await recoveryRun(store, f.cwd);
    const cursor = (await store.events(0, 1000)).at(-1)!.sequence;
    await store.claim(run.id, "recovered");

    const response = await eventStream(
      store,
      service,
      { after: cursor, epoch: await store.epoch() },
      new AbortController().signal,
    );

    const frames = await captureFrames(response.body!).finish();
    const events = await store.events(cursor, 1000);
    expect(events).toHaveLength(507);
    expect(frames).toEqual(expectedFrames(events));
    expect(frames).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("daemon run stdout never contains its bearer token", async () => {
  const f = fixture("private-output", "run: () => 1");

  const child = Bun.spawn(
    [process.execPath, CLI, "--home", f.home, "daemon", "run", "--port", "0"],
    { cwd: f.cwd, stdout: "pipe", stderr: "pipe" },
  );

  try {
    for (let attempt = 0; attempt < 100 && !readDaemonFile(f.home); attempt++) {
      await Bun.sleep(20);
    }

    const record = readDaemonFile(f.home);
    expect(record).toBeDefined();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(output).toContain(`http://127.0.0.1:${record!.port}`);
    expect(output).toContain("loopy ui");
    expect(output).not.toContain(record!.token);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("run paging includes every run sharing a timestamp", async () => {
  const { f, store, service } = await serviceFixture("paging");

  try {
    for (const id of ["a", "b"]) {
      await store.createRun({
        id,
        slug: "paging",
        workspace: f.cwd,
        bundleHash: "a".repeat(64),
        input: {},
        status: "queued",
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:00.000Z",
      });
    }

    const first = await service.listRuns(runsQuerySchema.parse({ limit: 1 }));
    expect(first.map((run) => run.id)).toEqual(["b"]);

    const second = await service.listRuns(
      runsQuerySchema.parse({ limit: 1, before: encodeRunCursor(first[0]!) }),
    );

    expect(second.map((run) => run.id)).toEqual(["a"]);
    expect(
      await service.listRuns(runsQuerySchema.parse({ before: encodeRunCursor(second[0]!) })),
    ).toEqual([]);
  } finally {
    store.close();
  }
});

async function waitForSuccess(store: ReturnType<typeof openRunStore>, id: string) {
  for (
    let attempt = 0;
    attempt < 300 && (await store.getRun(id))?.status !== "succeeded";
    attempt++
  ) {
    await Bun.sleep(20);
  }
}

test("hook POST wakes a run to completion while the daemon runs", async () => {
  const f = fixture("hook-completion", 'run: async () => hook("approve")');
  await save(f);
  const run = object((await cli(f, "run", "hook-completion")).stdout);
  const store = openRunStore(f.home);
  const daemon = localDaemon({ ...f, store, port: 0 });
  const origin = new URL(daemon.start()).origin;
  const running = daemon.run();

  try {
    const [hook] = await store.listHooks(String(run.id));

    const response = await fetch(`${origin}/api/hooks/${hook!.token}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readDaemonFile(f.home)!.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: { ok: true } }),
    });

    expect(response.status).toBe(200);

    await waitForSuccess(store, String(run.id));
    expect(await store.getRun(String(run.id))).toMatchObject({
      status: "succeeded",
      output: { ok: true },
    });
  } finally {
    await daemon.stop();
    await running;
    store.close();
  }
}, 10_000);

test("SSE bounds an unread client while another receives and coalesces a burst", async () => {
  const { f, store, service } = await serviceFixture("slow-client");

  const query = { after: 0, epoch: await store.epoch() };
  const slow = await eventStream(store, service, query, new AbortController().signal);
  const fast = await eventStream(store, service, query, new AbortController().signal);
  const capture = captureFrames(fast.body!);
  const selects = spyOn(store, "events");

  try {
    const writes = [...Array.from({ length: 40 }).keys()].map((id) =>
      store.createRun({
        id: String(id),
        slug: "slow-client",
        workspace: f.cwd,
        bundleHash: "a".repeat(64),
        input: "x".repeat(40_000),
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    await Promise.all(writes);
    const frames = await capture.finish();
    expect(frames.flatMap((frame) => frame.sequences)).toEqual(
      [...Array.from({ length: 40 }).keys()].map((index) => index + 1),
    );
    expect(selects.mock.calls.length).toBeLessThan(10);
    await expect(slow.body!.getReader().read()).rejects.toThrow("SSE client fell behind.");
  } finally {
    selects.mockRestore();
    store.close();
  }
});

test("local server leaves event pruning to the runtime daemon", async () => {
  const { f, store } = await serviceFixture("retention-owner");
  const prune = spyOn(store, "pruneEvents");
  const daemon = localDaemon({ ...f, store, port: 0 });

  try {
    daemon.start();
    expect(prune).not.toHaveBeenCalled();
    await daemon.tick();
    expect(prune).toHaveBeenCalledTimes(1);
    await daemon.tick();
    expect(prune).toHaveBeenCalledTimes(1);
  } finally {
    await daemon.stop();
    prune.mockRestore();
    store.close();
  }
});
