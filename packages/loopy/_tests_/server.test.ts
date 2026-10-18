import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import {
  cursorViewSchema,
  daemonViewSchema,
  type ErrorCode,
  encodeRunCursor,
  errorBodySchema,
  type Json,
  nodeIdSchema,
  routes,
  runSnapshotViewSchema,
  runViewSchema,
  scheduleViewSchema,
  serverEventSchema,
} from "../src/contract/index.js";
import { requireRecord, revision } from "../src/core/index.js";
import { SYSTEM_CLOCK } from "../src/host/index.js";
import {
  LoopyService,
  localDaemon,
  Registry,
  readDaemonFile,
  ServiceError,
} from "../src/local/index.js";
import { eventStream } from "../src/local/server/events.js";
import { apiRoutes, dispatch } from "../src/local/server/routes.js";
import { openRunStore } from "../src/store/index.js";
import { CLI, fixture, object, roots, runFixture, save } from "./cli-fixture.js";
import { newRun, until } from "./fixture.js";

const daemonMetadata = { startedAt: new Date(0).toISOString(), concurrency: 4 };

const servers: Awaited<ReturnType<typeof startDaemon>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function startDaemon(options: { home: string; cwd: string; port: number; assets?: string }) {
  const store = openRunStore(options.home);
  const daemon = localDaemon({ concurrency: 4, ...options, store });

  return {
    url: await daemon.start(),
    async stop() {
      await daemon.stop();
      store.close();
    },
  };
}

test("API returns run records, step traces and cursor logs", async () => {
  const f = fixture("api", `run: () => { log("first"); log("second"); return 2; }`);

  await save(f);
  const run = object((await runFixture(f)).stdout);
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const request = (path: string) => fetch(`${url.origin}/api${path}`, { headers });
  const detail = requireRecord(await (await request(`/runs/${run.id}`)).json(), "Run detail");
  expect(detail.nodeRuns).toMatchObject([
    { status: "succeeded" },
    { status: "succeeded" },
    { status: "succeeded" },
  ]);
  expect(detail.logs).toMatchObject([{ message: "first" }, { message: "second" }]);
  expect(await (await request(`/runs/${run.id}/logs?after=1`)).json()).toMatchObject([
    { message: "second" },
  ]);
  expect((await request(`/runs/${run.id}/logs?after=-1`)).status).toBe(400);
  expect((await request("/runs/missing/logs")).status).toBe(404);
  expect(await (await request("/runs")).json()).toMatchObject([{ id: run.id }]);
});

test("the daemon server requires its token and origin, serves pinned assets and serves authenticated API reads", async () => {
  const f = fixture("dashboard", "run: () => 1");
  await save(f);
  const assets = join(f.cwd, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "original dashboard");
  const server = await startDaemon({ home: f.home, cwd: f.cwd, assets, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
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
    expect(errorBodySchema.parse(await response.json()).error.code).toBe(code);
  }

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
  const f = fixture("server-errors", "run: () => 1");
  await save(f);
  const run = object((await runFixture(f)).stdout);
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };

  for (const path of [`/api/runs/${run.id}/logs?after=bad`, "/api/runs?limit=300"]) {
    const response = await fetch(`${url.origin}${path}`, { headers });
    expect(response.status).toBe(400);
    expect(errorBodySchema.parse(await response.json()).error.code).toBe("bad_request");
  }

  writeFileSync(join(f.cwd, ".loopy", "loopies", "server-errors.json"), "invalid JSON");
  const failed = await fetch(`${url.origin}/api/loopies`, { headers });
  expect(failed.status).toBe(500);
  expect(errorBodySchema.parse(await failed.json()).error.code).toBe("internal");
  expect((await fetch(`${url.origin}/api/config`, { headers })).status).toBe(404);
});

test("API returns the contract snapshot, rejects unknown query keys and keeps cursor log reads", async () => {
  const f = fixture("summary", 'run: () => { log("hello"); return 1; }');

  await save(f);
  const run = object((await runFixture(f)).stdout);
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const path = `${url.origin}/api/runs/${run.id}`;
  const full = object(await (await fetch(path, { headers })).text());
  expect(full.nodeRuns).toHaveLength(2);
  expect(full.logs).toHaveLength(1);
  // The old viewer's logs=false switch is gone; strict query parsing rejects it.
  expect((await fetch(`${path}?logs=false`, { headers })).status).toBe(400);
  expect(await (await fetch(`${path}/logs?after=0`, { headers })).json()).toEqual(full.logs);
  expect(await (await fetch(`${path}/logs?after=1`, { headers })).json()).toEqual([]);
  expect((await fetch(`${url.origin}/api/runs/missing`, { headers })).status).toBe(404);
});

test("contract routes start, snapshot, resume and cancel without exposing owner tokens", async () => {
  const f = fixture("contract", "run: () => null");
  await save(f);
  const initialStore = openRunStore(f.home);
  await initialStore.createRun({ ...newRun(), id: "initial", slug: "contract", workspace: f.cwd });
  initialStore.close();
  const initial = { id: "initial" };
  const server = await startDaemon({ ...f, port: 0 });
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
  expect(snapshot.run.waitingOn).toBeNull();
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
  const server = await startDaemon({ ...f, port: 0, assets });
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

  const decoded = JSON.parse(data);
  const events = serverEventSchema.array().parse(decoded);
  expect(events).toEqual(decoded);

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
      `import { openRunStore } from ${JSON.stringify(resolve(import.meta.dir, "../src/store/index.ts"))}; const store = openRunStore(process.argv[1]); await store.createRun(JSON.parse(process.argv[2])); store.close();`,
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
    revision: "a".repeat(64),
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
  const daemon = localDaemon({ concurrency: 4, ...f, store, port: 0 });
  const url = new URL(await daemon.start());

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
        apiRoutes({ service, store, cwd: f.cwd, daemon: daemonMetadata }),
        request,
        new URL(request.url),
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
    ["not_claimable", 409],
    ["owned_elsewhere", 409],
    ["bad_request", 400],
    ["invalid_schedule", 400],
    ["stale_cursor", 410],
    ["unauthorized", 401],
    ["forbidden", 403],
    ["internal", 500],
    ["invalid_cron", 400],
    ["invalid_timezone", 400],
  ];

  const list = spyOn(service, "listRuns");

  try {
    for (const [code, status] of cases) {
      list.mockRejectedValue(new ServiceError(code));

      const response = await dispatch(
        apiRoutes({ service, store, cwd: f.cwd, daemon: daemonMetadata }),
        request,
        new URL(request.url),
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
    revision: "a".repeat(64),
    input: {},
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    owner: { token: "old", host: "another-host", pid: 1, heartbeatAt: new Date(0).toISOString() },
  } as const;

  await store.createRun(run);

  await store.apply({
    runId: run.id,
    token: "old",
    effects: [...Array(505).keys()].map((seq) => ({
      kind: "write_node_run",
      nodeRun: {
        key: { runId: run.id, nodeId: nodeIdSchema.parse(`node-${seq}`), scope: [] },
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: run.createdAt,
        receipt: "none",
      },
    })),
  });

  return run;
}

test("SSE keeps a node transaction whole across the replay batch limit", async () => {
  const { f, store, service } = await serviceFixture("batch");

  try {
    await recoveryRun(store, f.cwd);
    const cursor = 1;

    const response = await eventStream(
      store,
      service,
      { after: cursor, epoch: await store.epoch() },
      new AbortController().signal,
    );

    const frames = await captureFrames(response.body!).finish();
    const events = await store.events(cursor, 1000);
    expect(events).toHaveLength(505);
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
        revision: "a".repeat(64),
        input: {},
        status: "queued",
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:00.000Z",
      });
    }

    const first = await service.listRuns(routes.runs.query.parse({ limit: 1 }));
    expect(first.map((run) => run.id)).toEqual(["b"]);

    const second = await service.listRuns(
      routes.runs.query.parse({ limit: 1, before: encodeRunCursor(first[0]!) }),
    );

    expect(second.map((run) => run.id)).toEqual(["a"]);
    expect(
      await service.listRuns(routes.runs.query.parse({ before: encodeRunCursor(second[0]!) })),
    ).toEqual([]);
  } finally {
    store.close();
  }
});

async function httpEvents(name: string) {
  const { f, store } = await serviceFixture(name);
  const daemon = localDaemon({ concurrency: 4, ...f, store, port: 0 });
  const url = new URL(await daemon.start());
  const headers = { Authorization: `Bearer ${readDaemonFile(f.home)!.token}` };
  const endpoint = `${url.origin}/api/events?after=0&epoch=${await store.epoch()}`;

  return {
    store,
    url,
    headers,
    endpoint,
    write: (id: number, bytes: number) =>
      store.createRun({ ...replayRun(f.cwd), id: String(id), input: "x".repeat(bytes) }),
    connect: (id: number) =>
      fetch(endpoint, { headers: { ...headers, "Last-Event-ID": String(id) } }),
    async close() {
      await daemon.stop();
      store.close();
    },
  };
}

async function waitForFrames(capture: ReturnType<typeof captureFrames>, count: number) {
  for (let attempt = 0; attempt < 500 && capture.frames.length < count; attempt++) {
    await Bun.sleep(10);
  }

  expect(capture.frames).toHaveLength(count);
}

test("SSE HTTP replay drains 45 large transactions from Last-Event-ID 1 in order", async () => {
  const http = await httpEvents("large-replay");

  try {
    for (let id = 1; id <= 46; id++) {
      await http.write(id, 40_000);
    }

    const response = await http.connect(1);
    expect(response.status).toBe(200);
    const capture = captureFrames(response.body!);
    await waitForFrames(capture, 45);
    expect(await capture.finish()).toEqual(expectedFrames(await http.store.events(1, 100)));
  } finally {
    await http.close();
  }
}, 15_000);

test("SSE HTTP replays an oversized transaction and live-delivers another whole frame", async () => {
  const http = await httpEvents("oversized-replay");

  try {
    await http.write(1, 0);
    await http.write(2, 1_100_000);
    const response = await http.connect(1);
    const capture = captureFrames(response.body!);
    await waitForFrames(capture, 1);
    await http.write(3, 1_100_000);
    await waitForFrames(capture, 2);
    expect(await capture.finish()).toEqual(expectedFrames(await http.store.events(1, 100)));
  } finally {
    await http.close();
  }
}, 15_000);

async function unreadHttp(http: Awaited<ReturnType<typeof httpEvents>>) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(http.endpoint, { headers: { ...http.headers, "Last-Event-ID": "1" } }, resolve).on(
      "error",
      reject,
    );
  });

  response.pause();
  const chunks: Buffer[] = [];

  const ended = new Promise<string>((resolve, reject) => {
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("close", () => resolve(Buffer.concat(chunks).toString()));
    response.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") {
        reject(error);
      }
    });
  });

  return { response, ended };
}

async function closedCursor(slow: Awaited<ReturnType<typeof unreadHttp>>) {
  await Bun.sleep(2300);
  slow.response.resume();

  const received = await Promise.race([
    slow.ended,
    Bun.sleep(3000).then(() => {
      throw new Error("Unread HTTP client was not closed.");
    }),
  ]);

  expect(slow.response.statusCode).toBe(200);

  const ids = received
    .split("\n\n")
    .slice(0, -1)
    .flatMap((frame) => parseFrame(frame.split("\n"))?.id ?? []);

  return ids.at(-1) ?? 1;
}

async function stalledHttpReader(name: string) {
  const http = await httpEvents(name);
  await http.write(1, 0);
  const slow = await unreadHttp(http);

  try {
    const response = await http.connect(1);
    const capture = captureFrames(response.body!);
    await Bun.sleep(50);

    for (let id = 2; id <= 401; id++) {
      await http.write(id, 40_000);
    }

    await waitForFrames(capture, 400);
    expect(await capture.finish()).toEqual(expectedFrames(await http.store.events(1, 1000)));
    const lastId = await closedCursor(slow);
    expect(lastId).toBeLessThan(401);

    return { http, lastId };
  } catch (error) {
    await http.close();
    throw error;
  } finally {
    slow.response.destroy();
  }
}

test("SSE HTTP closes a client that never reads while a concurrent reader gets every transaction", async () => {
  const { http } = await stalledHttpReader("unread-http");
  await http.close();
}, 20_000);

test("SSE HTTP reconnect from a closed client's last id has no gap", async () => {
  const { http, lastId } = await stalledHttpReader("unread-reconnect");

  try {
    const response = await http.connect(lastId);
    const capture = captureFrames(response.body!);
    await waitForFrames(capture, 401 - lastId);
    expect(await capture.finish()).toEqual(expectedFrames(await http.store.events(lastId, 1000)));
  } finally {
    await http.close();
  }
}, 20_000);

test("local server leaves event pruning to the runtime daemon", async () => {
  const { f, store } = await serviceFixture("retention-owner");
  const prune = spyOn(store, "pruneEvents");
  const daemon = localDaemon({ concurrency: 4, ...f, store, port: 0 });

  try {
    await daemon.start();
    expect(prune).not.toHaveBeenCalled();
    void daemon.run();
    await until(() => prune.mock.calls.length === 1);
    expect(prune).toHaveBeenCalledTimes(1);
  } finally {
    await daemon.stop();
    prune.mockRestore();
    store.close();
  }
});

async function scheduleApi() {
  const { f, store, service } = await serviceFixture("schedule-api");
  const table = apiRoutes({ service, store, cwd: f.cwd, daemon: daemonMetadata });

  const request = (path: string, method = "GET", body?: Json) => {
    const url = new URL(`http://localhost/api${path}`);

    return dispatch(
      table,
      new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
      url,
    );
  };

  return { store, service, request };
}

test("schedule routes round trip validated views and report status codes", async () => {
  const { store, request } = await scheduleApi();
  const path = "/loopies/schedule-api/schedule";

  try {
    expect(await (await request("/schedules")).json()).toEqual([]);
    const response = await request(path, "PUT", { cron: "* * * * *" });
    expect(response.status).toBe(200);
    const saved = scheduleViewSchema.parse(await response.json());
    expect(saved).toMatchObject({ slug: "schedule-api", enabled: true, lastFireKey: null });
    expect(await (await request("/schedules")).json()).toEqual([saved]);
    expect(
      await (await request(`${path}/enabled`, "POST", { enabled: false })).json(),
    ).toMatchObject({ enabled: false });

    const invalidBodies: { body: Json; code: ErrorCode }[] = [
      { body: { cron: "invalid" }, code: "invalid_cron" },
      { body: { cron: "* * * * *", tz: "Bad/Zone" }, code: "invalid_timezone" },
      { body: {}, code: "invalid_schedule" },
    ];

    for (const { body, code } of invalidBodies) {
      const invalid = await request(path, "PUT", body);
      expect(invalid.status).toBe(400);
      expect(errorBodySchema.parse(await invalid.json()).error.code).toBe(code);
    }

    const malformed = await request(path, "PUT", { enabled: "no" });
    expect(malformed.status).toBe(400);
    expect(errorBodySchema.parse(await malformed.json()).error.code).toBe("bad_request");
    expect((await request("/loopies/missing/schedule", "PUT", {})).status).toBe(404);
    expect(await (await request(path, "DELETE")).json()).toEqual({ deleted: true });
    expect((await request(`${path}/enabled`, "POST", { enabled: true })).status).toBe(404);
  } finally {
    store.close();
  }
});

test("schedule PUT publishes a saved SSE frame", async () => {
  const { store, service, request } = await scheduleApi();
  const controller = new AbortController();

  const stream = await eventStream(
    store,
    service,
    { after: 0, epoch: await store.epoch() },
    controller.signal,
  );

  const reader = stream.body!.getReader();

  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    expect(
      (await request("/loopies/schedule-api/schedule", "PUT", { cron: "* * * * *" })).status,
    ).toBe(200);
    const frame = new TextDecoder().decode((await reader.read()).value);
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    expect(data).toBeDefined();
    expect(serverEventSchema.array().parse(JSON.parse(data!.slice(6)))).toMatchObject([
      { entity: "schedule", kind: "saved", record: { slug: "schedule-api", cron: "* * * * *" } },
    ]);
  } finally {
    controller.abort();
    await reader.cancel();
    store.close();
  }
});

test("cursor endpoint bootstraps an empty dashboard and follows new events", async () => {
  const f = fixture("cursor", "run: () => 1");
  const server = await startDaemon({ home: f.home, cwd: f.cwd, port: 0 });
  servers.push(server);
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}` };
  const request = () => fetch(`${url.origin}/api/cursor`, { headers });
  const response = await request();
  expect(response.status).toBe(200);
  const initial = cursorViewSchema.parse(await response.json());
  expect(initial.cursor).toBe(0);
  expect(initial.epoch).toBeString();
  const store = openRunStore(f.home);

  try {
    await store.createRun(newRun());
    const current = cursorViewSchema.parse(await (await request()).json());
    expect(current).toEqual({ cursor: 1, epoch: initial.epoch });
    expect(current).toEqual(await store.eventCursor());
  } finally {
    store.close();
  }
});

function artifactState(paths: string[]) {
  return paths.map((path) => {
    const { ino, mtimeMs, ctimeMs, size, mode } = statSync(path);

    return { ino, mtimeMs, ctimeMs, size, mode };
  });
}

test("compiled save route verifies artifacts, stores private bundles and returns only GraphView", async () => {
  const { f, service, store } = await serviceFixture("compiled-save");
  const { compile } = await import("../src/compiler/index.js");
  const { compiledBody } = await import("./compiled-fixture.js");
  const source = join(f.cwd, "compiled.ts");
  const sdk = resolve(import.meta.dir, "../src/sdk/graph/index.ts");
  await Bun.write(
    source,
    `import {loopy,code} from ${JSON.stringify(sdk)}; export default loopy("compiled-save", {input:{},run:()=>code("answer",{in:{},out:{kind:"value",type:"number"},module:"./answer.ts"})});`,
  );
  await Bun.write(
    join(f.cwd, "answer.ts"),
    'throw new Error("Must not execute while saving."); export default () => 42;',
  );
  const result = await compile(source);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  const body = {
    ...(await compiledBody("compiled-save", source)),
    replace: true,
    graph: result.graph,
    revision: result.revision,
    bundles: result.bundles.map((bundle) => ({
      ...bundle,
      bytes: Buffer.from(bundle.bytes).toString("base64"),
    })),
  };

  const table = apiRoutes({ service, store, cwd: f.cwd, daemon: daemonMetadata });

  const put = async (payload: typeof body) => {
    const request = new Request("http://localhost/api/loopies/compiled-save", {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    return dispatch(table, request, new URL(request.url));
  };

  expect((await put({ ...body, revision: "0".repeat(64) })).status).toBe(400);
  expect((await put({ ...body, bundles: [] })).status).toBe(400);
  expect(
    (
      await put({
        ...body,
        bundles: body.bundles.map((bundle) => ({
          ...bundle,
          bytes: Buffer.from("changed").toString("base64"),
        })),
      })
    ).status,
  ).toBe(400);
  const response = await put(body);
  expect(response.status).toBe(200);
  const serialized = JSON.stringify(await response.json());
  expect(serialized).not.toMatch(/"(?:bytes|bundleHash|source|revision)":/);
  const registry = new Registry(f.home, f.cwd);
  const saved = registry.get("compiled-save");

  const paths = [
    join(registry.projectDirectory, "compiled-save.json"),
    registry.graphPath(saved.revision),
    ...saved.bundles.map((bundle) => registry.bundlePath(bundle.bundleHash)),
  ];

  const before = artifactState(paths);
  expect((await put(body)).status).toBe(200);
  expect(registry.get("compiled-save")).toEqual(saved);
  expect(artifactState(paths)).toEqual(before);
  expect(
    (
      await put({
        ...body,
        bundles: body.bundles.map((bundle) => ({
          ...bundle,
          bytes: Buffer.from("forged").toString("base64"),
        })),
      })
    ).status,
  ).toBe(400);
  const globalGraph = { ...body.graph, meta: { ...body.graph.meta, scope: "global" as const } };

  const globalBody = {
    ...body,
    graph: globalGraph,
    revision: await revision(globalGraph),
    source: { ...body.source, path: `${source}-global` },
  };

  expect((await put(globalBody)).status).toBe(200);

  const globalPaths = [
    join(registry.globalDirectory, "compiled-save.json"),
    registry.graphPath(globalBody.revision),
    ...saved.bundles.map((bundle) => registry.bundlePath(bundle.bundleHash)),
  ];

  const globalBefore = artifactState(globalPaths);
  expect((await put(globalBody)).status).toBe(200);
  expect(artifactState(globalPaths)).toEqual(globalBefore);
  expect(registry.get("compiled-save")).toEqual(saved);
  expect(saved.revision).toBe(result.revision);
  expect(saved.bundles).toEqual(
    result.bundles.map(({ nodeId, bundleHash }) => ({ nodeId, bundleHash })),
  );

  for (const bundle of result.bundles) {
    expect(statSync(registry.bundlePath(bundle.bundleHash)).mode & 0o777).toBe(0o600);
    expect([
      ...new Uint8Array(await Bun.file(registry.bundlePath(bundle.bundleHash)).arrayBuffer()),
    ]).toEqual([...bundle.bytes]);
  }
});

test("saving another revision retains the earlier graph and executable artifacts", async () => {
  const { f, service } = await serviceFixture("revisions");
  const { compile } = await import("../src/compiler/index.js");
  const { compiledBody } = await import("./compiled-fixture.js");
  const source = join(f.cwd, "revision.ts");
  await Bun.write(
    source,
    `import {loopy,code} from ${JSON.stringify(resolve(import.meta.dir, "../src/sdk/graph/index.ts"))}; export default loopy("revisions", {input:{},run:()=>code("value",{in:{},out:{kind:"value",type:"number"},module:"./value.ts"})});`,
  );
  const registry = new Registry(f.home, f.cwd);
  const revisions: string[] = [];

  for (const value of [1, 2]) {
    await Bun.write(join(f.cwd, "value.ts"), `export default ()=>${value};`);
    const compiled = await compile(source);

    if (!compiled.ok) {
      throw new Error(JSON.stringify(compiled.diagnostics));
    }

    await service.putLoopy("revisions", {
      ...(await compiledBody("revisions", source)),
      replace: true,
      graph: compiled.graph,
      revision: compiled.revision,
      bundles: compiled.bundles.map((bundle) => ({
        ...bundle,
        bytes: Buffer.from(bundle.bytes).toString("base64"),
      })),
    });
    revisions.push(compiled.revision);
  }

  expect(revisions[0]).not.toBe(revisions[1]);

  for (const revision of revisions) {
    const graph = await Bun.file(registry.graphPath(revision)).json();
    expect(graph.name).toBe("revisions");
    expect(statSync(registry.graphPath(revision)).mode & 0o777).toBe(0o600);
  }

  expect(revisions.at(-1)).toBe(registry.get("revisions").revision);
});
