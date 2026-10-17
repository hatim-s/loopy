import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonViewSchema,
  type ErrorCode,
  errorBodySchema,
  type Json,
  runSnapshotViewSchema,
  runViewSchema,
  serverEventSchema,
} from "../src/contract/index.js";
import { requireRecord } from "../src/core/index.js";
import {
  LoopyService,
  localDaemon,
  openRunStore,
  Registry,
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

test("API always returns the contract snapshot and keeps separate cursor log reads", async () => {
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
  const summary = object(await (await fetch(`${path}?logs=false`, { headers })).text());
  expect(full.steps).toHaveLength(1);
  expect(full.logs).toHaveLength(1);
  expect(summary).toEqual(full);
  expect(await (await fetch(`${path}/logs?after=0`, { headers })).json()).toEqual(full.logs);
  expect(await (await fetch(`${path}/logs?after=1`, { headers })).json()).toEqual([]);
  expect((await fetch(`${url.origin}/api/runs/missing?logs=false`, { headers })).status).toBe(404);
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

  const request = (path: string, body?: Json | null) =>
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
  expect((await fetch(`${origin}/`, { headers: { Host: "evil.example" } })).status).toBe(403);
});

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const read = async () => {
    let text = "";

    while (!text.includes("data: ")) {
      const result = await reader.read();

      if (result.done) {
        throw new Error("SSE closed before a transaction.");
      }

      text += new TextDecoder().decode(result.value);
    }

    return text;
  };

  return Promise.race([
    read(),
    Bun.sleep(500).then(() => {
      throw new Error("No SSE delivery within 500 ms.");
    }),
  ]);
}

test("SSE replays then merges local and second-connection writes, resumes and rejects stale cursors", async () => {
  const f = fixture("events", "run: () => 1");
  await save(f);
  const store = openRunStore(f.home);
  const other = openRunStore(f.home);
  const daemon = localDaemon({ ...f, store, port: 0 });
  const url = new URL(daemon.start());

  const headers = {
    Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
  };

  const run = {
    id: "replay",
    slug: "events",
    workspace: f.cwd,
    bundleHash: "a".repeat(64),
    input: {},
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as const;

  const controller = new AbortController();

  try {
    await store.createRun(run);
    const endpoint = `${url.origin}/api/events?after=0&epoch=${await store.epoch()}`;
    expect((await fetch(`${url.origin}/api/events?after=0&epoch=wrong`, { headers })).status).toBe(
      410,
    );
    const response = await fetch(endpoint, { headers, signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(await frame(reader)).toContain('"id":"replay"');
    await other.createRun({ ...run, id: "external" });
    const external = await frame(reader);
    expect(external).toContain('"id":"external"');
    await store.claim(run.id, "owner");
    const local = await frame(reader);
    expect(local).toContain('"kind":"claimed"');
    expect(local).not.toContain('"token":"owner"');
    const cursor = (await store.events(0, 100)).at(-1)!.sequence;
    await reader.cancel();
    controller.abort();

    const resumed = await fetch(endpoint, {
      headers: { ...headers, "Last-Event-ID": String(cursor - 1) },
    });

    const resumedReader = resumed.body!.getReader();
    expect(await frame(resumedReader)).toContain(`id: ${cursor}`);
    await resumedReader.cancel();
    await store.pruneEvents("2100-01-01T00:00:00.000Z");
    await store.createRun({ ...run, id: "retained" });
    expect((await fetch(endpoint, { headers })).status).toBe(410);
  } finally {
    controller.abort();
    await daemon.stop();
    other.close();
    store.close();
  }
});

test("SSE disconnect removes the subscriber and stops polling", async () => {
  const f = fixture("disconnect", "run: () => 1");
  await save(f);
  const store = openRunStore(f.home);

  const service = new LoopyService({
    home: f.home,
    store,
    registry: () => new Registry(f.home, f.cwd),
    clock: SYSTEM_CLOCK,
  });

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
  const f = fixture("leak", "run: () => 1");
  await save(f);
  const store = openRunStore(f.home);

  const service = new LoopyService({
    home: f.home,
    store,
    registry: () => new Registry(f.home, f.cwd),
    clock: SYSTEM_CLOCK,
  });

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
    ).rejects.toThrow("Response contains fields outside its contract.");
  } finally {
    list.mockRestore();
    store.close();
  }
});

test("service error codes serialize with their HTTP status", async () => {
  const f = fixture("errors", "run: () => 1");
  await save(f);
  const store = openRunStore(f.home);

  const service = new LoopyService({
    home: f.home,
    store,
    registry: () => new Registry(f.home, f.cwd),
    clock: SYSTEM_CLOCK,
  });

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

test("SSE keeps a recovery transaction whole across the replay batch limit", async () => {
  const f = fixture("batch", "run: () => 1");
  await save(f);
  const store = openRunStore(f.home);

  const service = new LoopyService({
    home: f.home,
    store,
    registry: () => new Registry(f.home, f.cwd),
    clock: SYSTEM_CLOCK,
  });

  const run = {
    id: "batch",
    slug: "batch",
    workspace: f.cwd,
    bundleHash: "a".repeat(64),
    input: {},
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    owner: { token: "old", host: "another-host", pid: 1, heartbeatAt: new Date(0).toISOString() },
  } as const;

  try {
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

    const cursor = (await store.events(0, 1000)).at(-1)!.sequence;
    await store.claim(run.id, "recovered");

    const response = await eventStream(
      store,
      service,
      { after: cursor, epoch: await store.epoch() },
      new AbortController().signal,
    );

    const reader = response.body!.getReader();
    const text = await frame(reader);
    const data = text.split("\n").find((line) => line.startsWith("data: "))!;
    const events = serverEventSchema.array().parse(JSON.parse(data.slice(6)));
    expect(events).toHaveLength(507);
    expect(new Set(events.map((event) => event.txn)).size).toBe(1);
    expect(text).toContain(`id: ${events.at(-1)!.sequence}`);
    expect(events.at(-1)).toMatchObject({
      entity: "run",
      kind: "claimed",
      record: { status: "running" },
    });
    await reader.cancel();
  } finally {
    store.close();
  }
});
