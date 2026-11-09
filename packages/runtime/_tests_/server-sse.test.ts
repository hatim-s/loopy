import { expect, spyOn, test } from "bun:test";
import { get, type IncomingMessage } from "node:http";
import { join } from "node:path";
import {
  decodeBoundary,
  decodeEventBatch,
  nodeIdSchema,
  type SseFrame,
  serverEventSchema,
  splitSseFrames,
} from "@loopy/contract";
import { eventFrame } from "@loopy/contract/server";
import type { RuntimeEvent } from "@loopy/core";
import { loopy } from "@loopy/sdk";
import { Effect, Schema, Scope } from "effect";
import { localDaemon, readDaemonFile } from "../src/local";
import { serveHttp } from "./fixtures/http-server";
import { fixture, save } from "./fixtures/project";
import { daemonToken, serviceFixture } from "./fixtures/server";
import { fixtureStore } from "./fixtures/service-runtime";
import { fixtureScope } from "./fixtures/test-scope";
import { bounded, until } from "./fixtures/wait";

/** What a test compares: the frame id and the sequences and transactions its batch carries. */
function frameView(frame: SseFrame) {
  const events = decodeEventBatch(frame.data);

  return {
    id: Number(frame.id),
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

  const frames: {
    id: number;
    sequences: number[];
    transactions: string[];
  }[] = [];

  let buffer = "";

  const reading = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const split = splitSseFrames(buffer + decoder.decode(chunk.value, { stream: true }));
      buffer = split.rest;
      frames.push(...split.frames.map(frameView));
    }
  })();

  return {
    frames,
    /** Waits for `count` frames, stops reading and checks no partial frame was left behind. */
    async finish(count: number) {
      await until(`${count} SSE frames`, () => frames.length >= count);
      await reader.cancel();
      await reading;
      expect(buffer).toBe("");

      return frames;
    },
  };
}

function expectedFrames(events: RuntimeEvent[]) {
  const frames: {
    id: number;
    sequences: number[];
    transactions: string[];
  }[] = [];

  for (const event of events) {
    const last = frames.at(-1);

    if (last && last.transactions[0] === event.txn) {
      last.id = event.sequence;
      last.sequences.push(event.sequence);
    } else {
      frames.push({ id: event.sequence, sequences: [event.sequence], transactions: [event.txn] });
    }
  }

  return frames;
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
  events: RuntimeEvent[],
) {
  const cursor = events[0]!.sequence;

  const resumed = await fetch(endpoint, {
    headers: { ...headers, "Last-Event-ID": String(cursor) },
  });

  const expected = expectedFrames(events.filter((event) => event.sequence > cursor));
  expect(await captureFrames(resumed.body!).finish(expected.length)).toEqual(expected);
}

test("SSE delivers exact transactions across replay, live commits and Last-Event-ID reconnect", async () => {
  const f = fixture(loopy("events", { input: {}, run: () => 1 }));
  await save(f);
  const store = await fixtureStore(f.home);

  const daemon = await Effect.runPromise(
    localDaemon({ concurrency: 4, ...f, store, port: 0, assets: join(f.cwd, "assets") }).pipe(
      Effect.provideService(Scope.Scope, fixtureScope()),
    ),
  );

  const url = new URL(await Effect.runPromise(daemon.start));

  const headers = {
    Authorization: `Bearer ${daemonToken(url)}`,
  };

  const run = replayRun(f.cwd);

  try {
    await Effect.runPromise(store.createRun(run));
    const endpoint = `${url.origin}/api/events?after=0&epoch=${await Effect.runPromise(store.epoch())}`;
    expect((await fetch(`${url.origin}/api/events?after=0&epoch=wrong`, { headers })).status).toBe(
      410,
    );
    const response = await fetch(endpoint, { headers });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const capture = captureFrames(fragment(response.body!));
    await Effect.runPromise(store.claim(run.id, "owner"));
    const events = await Effect.runPromise(store.events(0, 100));
    const expected = expectedFrames(events);
    expect(await capture.finish(expected.length)).toEqual(expected);
    await reconnectFrames(endpoint, headers, events);
    await Effect.runPromise(store.pruneEvents("2100-01-01T00:00:00.000Z"));
    await Effect.runPromise(store.createRun({ ...run, id: "retained" }));
    expect((await fetch(endpoint, { headers })).status).toBe(410);
  } finally {
    await Effect.runPromise(daemon.stop);
    await Effect.runPromise(store.close());
  }
});

test("SSE disconnect removes the subscriber", async () => {
  const { f, store, service } = await serviceFixture("disconnect");
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

  const { request } = serveHttp({ service, store, cwd: f.cwd });
  const epoch = await Effect.runPromise(store.epoch());
  const response = await request(`/events?after=0&epoch=${epoch}`);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
  expect(active).toBe(1);
  await reader.cancel();
  await until("the stream to unsubscribe", () => active === 0);
  await Effect.runPromise(store.close());
  subscribe.mockRestore();
});

async function recoveryRun(store: Awaited<ReturnType<typeof fixtureStore>>, workspace: string) {
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

  await Effect.runPromise(store.createRun(run));
  await Effect.runPromise(
    store.apply({
      runId: run.id,
      token: "old",
      effects: [...Array(505).keys()].map((seq) => ({
        kind: "write_node_run",
        nodeRun: {
          key: { runId: run.id, nodeId: decodeBoundary(nodeIdSchema)(`node-${seq}`), scope: [] },
          status: "running",
          attempt: 1,
          maxAttempts: 1,
          startedAt: run.createdAt,
          receipt: "none",
        },
      })),
    }),
  );

  return run;
}

test("SSE keeps a node transaction whole across the replay batch limit", async () => {
  const { f, store, service } = await serviceFixture("batch");

  try {
    await recoveryRun(store, f.cwd);
    const cursor = 1;

    const epoch = await Effect.runPromise(store.epoch());

    const response = await serveHttp({ service, store, cwd: f.cwd }).request(
      `/events?after=${cursor}&epoch=${epoch}`,
    );

    const frames = await captureFrames(response.body!).finish(1);
    const events = await Effect.runPromise(store.events(cursor, 1000));
    expect(events).toHaveLength(505);
    expect(frames).toEqual(expectedFrames(events));
    expect(frames).toHaveLength(1);
  } finally {
    await Effect.runPromise(store.close());
  }
});

async function httpEvents(name: string) {
  const { f, store, service } = await serviceFixture(name);

  const run = {
    ...replayRun(f.cwd),
    status: "running" as const,
    owner: { token: "owner", host: "fixture", pid: 1, heartbeatAt: new Date().toISOString() },
  };

  await Effect.runPromise(store.createRun(run));

  const daemon = await Effect.runPromise(
    localDaemon({ concurrency: 4, ...f, store, port: 0, assets: join(f.cwd, "assets") }).pipe(
      Effect.provideService(Scope.Scope, fixtureScope()),
    ),
  );

  const url = new URL(await Effect.runPromise(daemon.start));
  const headers = { Authorization: `Bearer ${readDaemonFile(f.home)!.token}` };
  const endpoint = `${url.origin}/api/events?after=0&epoch=${await Effect.runPromise(store.epoch())}`;

  return {
    store,
    url,
    headers,
    endpoint,
    async write(id: number, rows: number) {
      const after = (await Effect.runPromise(store.eventCursor())).cursor;
      // Each output survives the 16 KiB preview cap. Rows share one durable transaction.
      const output = "x".repeat(16000);
      await Effect.runPromise(
        store.apply({
          runId: run.id,
          token: "owner",
          effects: [...Array(rows).keys()].map((index) => ({
            kind: "write_node_run" as const,
            nodeRun: {
              key: {
                runId: run.id,
                nodeId: decodeBoundary(nodeIdSchema)(`txn-${id}-node-${index}`),
                scope: [],
              },
              status: "succeeded" as const,
              attempt: 1,
              maxAttempts: 1,
              startedAt: run.createdAt,
              endedAt: run.createdAt,
              receipt: "finished" as const,
              output,
            },
          })),
        }),
      );
      const events = await Effect.runPromise(store.events(after, rows));

      const data = decodeBoundary(Schema.Array(serverEventSchema))(
        await Effect.runPromise(service.events(events)),
      );

      expect(data).toHaveLength(rows);
      expect(
        data.every(
          (event) =>
            event.entity === "node" &&
            event.record.status === "succeeded" &&
            event.record.output === output,
        ),
      ).toBe(true);
      const cursor = events.at(-1)!.sequence;

      return Buffer.byteLength(eventFrame(cursor, [...data]));
    },
    connect: (id: number) =>
      fetch(endpoint, { headers: { ...headers, "Last-Event-ID": String(id) } }),
    async close() {
      await Effect.runPromise(daemon.stop);
      await Effect.runPromise(store.close());
    },
  };
}

test("SSE HTTP replay drains 45 large transactions from Last-Event-ID 1 in order", async () => {
  const http = await httpEvents("large-replay");

  try {
    for (let id = 2; id <= 46; id++) {
      expect(await http.write(id, 4)).toBeGreaterThan(64000);
    }

    const response = await http.connect(1);
    expect(response.status).toBe(200);
    const expected = expectedFrames(await Effect.runPromise(http.store.events(1, 1000)));
    expect(expected).toHaveLength(45);
    expect(await captureFrames(response.body!).finish(45)).toEqual(expected);
  } finally {
    await http.close();
  }
}, 15000);

test("SSE HTTP replays a transaction over 1 MiB and live-delivers another whole frame", async () => {
  const http = await httpEvents("oversized-replay");

  try {
    expect(await http.write(2, 80)).toBeGreaterThan(1024 * 1024);
    const response = await http.connect(1);
    const capture = captureFrames(response.body!);
    await until("the replayed frame", () => capture.frames.length >= 1);
    expect(await http.write(3, 80)).toBeGreaterThan(1024 * 1024);
    expect(await capture.finish(2)).toEqual(
      expectedFrames(await Effect.runPromise(http.store.events(1, 1000))),
    );
  } finally {
    await http.close();
  }
}, 15000);

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

async function closedCursor(
  slow: Awaited<ReturnType<typeof unreadHttp>>,
  expected: ReturnType<typeof expectedFrames>,
  subscribers: () => number,
) {
  // The server drops a reader that stops pulling, which ends its store subscription.
  await until("the stalled reader to be dropped", () => subscribers() === 0);
  slow.response.resume();
  const received = await bounded(slow.ended, "Closing the unread HTTP client", 3000);

  expect(slow.response.statusCode).toBe(200);

  const frames = splitSseFrames(received).frames.map(frameView);

  expect(frames.length).toBeGreaterThan(0);
  expect(frames).toEqual(expected.slice(0, frames.length));

  return frames.at(-1)!.id;
}

const PRESSURE_TRANSACTIONS = 128;

const PRESSURE_ROWS = 40;

async function stalledHttpReader(name: string) {
  const http = await httpEvents(name);
  let subscribers = 0;
  const subscribe = http.store.subscribe.bind(http.store);

  spyOn(http.store, "subscribe").mockImplementation((listener) => {
    subscribers++;
    const unsubscribe = subscribe(listener);

    return () => {
      subscribers--;
      unsubscribe();
    };
  });

  const slow = await unreadHttp(http);

  try {
    const response = await http.connect(1);
    const capture = captureFrames(response.body!);
    await until("both readers to subscribe", () => subscribers === 2);
    let bytes = 0;

    // Exceed macOS loopback buffer autotuning while keeping every output below the preview cap.
    for (let id = 2; id < PRESSURE_TRANSACTIONS + 2; id++) {
      bytes += await http.write(id, PRESSURE_ROWS);
      // Let the active socket drain between synchronous SQLite transactions.
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(bytes).toBeGreaterThan(64 * 1024 * 1024);

    const expected = expectedFrames(
      await Effect.runPromise(http.store.events(1, PRESSURE_TRANSACTIONS * PRESSURE_ROWS)),
    );

    expect(expected).toHaveLength(PRESSURE_TRANSACTIONS);
    expect(expected.every((frame) => frame.sequences.length === PRESSURE_ROWS)).toBe(true);
    expect(await capture.finish(expected.length)).toEqual(expected);
    const lastId = await closedCursor(slow, expected, () => subscribers);
    expect(lastId).toBeLessThan(expected.at(-1)!.id);
    expect([1, ...expected.map((frame) => frame.id)]).toContain(lastId);

    return { http, lastId };
  } catch (error) {
    await http.close();
    throw error;
  } finally {
    slow.response.destroy();
  }
}

test("SSE HTTP closes a client that never reads, and reconnecting from its last id has no gap", async () => {
  const { http, lastId } = await stalledHttpReader("unread-reconnect");

  try {
    const response = await http.connect(lastId);
    const capture = captureFrames(response.body!);

    const expected = expectedFrames(
      await Effect.runPromise(http.store.events(lastId, PRESSURE_TRANSACTIONS * PRESSURE_ROWS)),
    );

    expect(expected.length).toBeGreaterThan(0);
    expect(await capture.finish(expected.length)).toEqual(expected);
  } finally {
    await http.close();
  }
}, 20000);
