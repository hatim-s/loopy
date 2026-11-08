import { afterAll, expect, test } from "bun:test";
import type { RunView } from "@loopy/contract";
import { Effect } from "effect";
import { BackendError } from "../src/backend/backend";
import { runRequest } from "../src/backend/http-wire";
import { localHttpBackend } from "../src/backend/local-http";

const run: RunView = {
  id: "run/1",
  slug: "triage",
  workspace: "/work",
  input: null,
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
  owner: null,
  ownerStale: false,
  waitingOn: null,
  status: "queued",
};

type Seen = { method: string; path: string; authorization: string | null; body: string };

const seen: Seen[] = [];

let reply: () => Response = () => Response.json(run);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    seen.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });

    return reply();
  },
});

afterAll(() => server.stop(true));

const backend = localHttpBackend({ baseUrl: server.url.origin, token: "secret" });

function last(): Seen | undefined {
  return seen.at(-1);
}

test("each call uses the method and path from the route table, with the token", async () => {
  reply = () => Response.json(run);

  await backend.call("resumeRun", { params: { id: "run/1" } });
  expect(last()).toEqual({
    method: "POST",
    path: "/api/runs/run%2F1/resume",
    authorization: "Bearer secret",
    body: "",
  });

  await backend.call("resolveHook", {
    params: { token: "tok" },
    body: { payload: { approved: true } },
  });
  expect(last()?.method).toBe("POST");
  expect(last()?.path).toBe("/api/hooks/tok");
  expect(JSON.parse(last()?.body ?? "")).toEqual({ payload: { approved: true } });

  // A slug alone can name another project's loopy, so both calls carry the view's workspace.
  await backend.call("startRun", {
    params: { slug: "triage" },
    body: { input: { name: "Hatim" }, workspace: "/work/a" },
  });
  expect(last()?.path).toBe("/api/loopies/triage/runs");
  expect(JSON.parse(last()?.body ?? "")).toEqual({
    input: { name: "Hatim" },
    workspace: "/work/a",
  });

  await expect(
    backend.call("graph", { params: { slug: "triage" }, query: { workspace: "/work/a" } }),
  ).rejects.toBeInstanceOf(BackendError);
  expect(last()?.path).toBe("/api/loopies/triage/graph?workspace=%2Fwork%2Fa");

  reply = () => Response.json({ runs: [run], next: null });
  await backend.call("runs", { query: { slug: "triage", limit: 20 } });
  expect(last()?.method).toBe("GET");
  expect(last()?.path).toBe("/api/runs?slug=triage&limit=20");

  reply = () => Response.json([]);
  await backend.call("logs", { params: { id: "run/1" }, query: { after: 7 } });
  expect(last()?.path).toBe("/api/runs/run%2F1/logs?after=7");
});

test("a response that fails the route schema is rejected", async () => {
  reply = () => Response.json({ ...run, status: "exploded" });

  const failure = backend.call("cancelRun", { params: { id: "run/1" } });

  await expect(failure).rejects.toBeInstanceOf(BackendError);
  await expect(failure).rejects.toMatchObject({ code: "malformed_response" });
});

test("an error body becomes a BackendError with the server's code and message", async () => {
  reply = () =>
    Response.json(
      { error: { code: "not_claimable", message: "Run is finished." } },
      { status: 409 },
    );

  await expect(backend.call("resumeRun", { params: { id: "run/1" } })).rejects.toEqual(
    new BackendError("not_claimable", "Run is finished."),
  );
});

test.each([
  [401, "unauthorized"],
  [403, "forbidden"],
  [500, "internal"],
] as const)("GET %i preserves the contract error %s", async (status, code) => {
  reply = () => Response.json({ error: { code, message: "Server guidance." } }, { status });
  const failure = backend.call("loopies", {});

  await expect(failure).rejects.toBeInstanceOf(BackendError);
  await expect(failure).rejects.toMatchObject({ code, message: "Server guidance." });
});

test("the event stream ends with reset when the server no longer holds the cursor", async () => {
  reply = () =>
    Response.json({ error: { code: "stale_cursor", message: "Refetch." } }, { status: 410 });

  const end = await backend.events({
    after: 5,
    epoch: "e1",
    signal: new AbortController().signal,
    onBatch: () => undefined,
    onState: () => undefined,
  });

  expect(end).toBe("reset");
  expect(last()?.path).toBe("/api/events?after=5&epoch=e1");
});

test("frames split across chunks arrive as batches and a reconnect resumes after the last one", async () => {
  const event = (sequence: number) => ({
    sequence,
    at: run.createdAt,
    txn: `t${sequence}`,
    entity: "run",
    kind: "claimed",
    runId: run.id,
    record: run,
  });

  const body = `data: ${JSON.stringify([event(11)])}\n\n: ping\n\ndata: ${JSON.stringify([event(12)])}\n\n`;
  const middle = Math.floor(body.length / 2);
  let streamed = false;

  reply = () => {
    if (streamed) {
      return Response.json(
        { error: { code: "stale_cursor", message: "Refetch." } },
        { status: 410 },
      );
    }

    streamed = true;

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body.slice(0, middle)));
          controller.enqueue(new TextEncoder().encode(body.slice(middle)));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };

  const batches: number[][] = [];

  const end = await backend.events({
    after: 10,
    epoch: "e1",
    signal: new AbortController().signal,
    onBatch: (batch) => batches.push(batch.map((item) => item.sequence)),
    onState: () => undefined,
  });

  expect(batches).toEqual([[11], [12]]);
  expect(end).toBe("reset");
  expect(last()?.path).toBe("/api/events?after=12&epoch=e1");
});

test("a malformed 410 is rejected instead of triggering reset", async () => {
  reply = () => Response.json({ error: "broken" }, { status: 410 });
  await expect(
    backend.events({
      after: 0,
      epoch: "e1",
      signal: new AbortController().signal,
      onState: () => undefined,
      onBatch: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "malformed_response" });
});

test("a valid non-cursor 410 preserves its error code", async () => {
  reply = () =>
    Response.json({ error: { code: "not_found", message: "Missing." } }, { status: 410 });
  await expect(
    backend.events({
      after: 0,
      epoch: "e1",
      signal: new AbortController().signal,
      onState: () => undefined,
      onBatch: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "not_found", message: "Missing." });
});

test("a malformed frame cancels the open response stream", async () => {
  const cancelled = Promise.withResolvers<void>();
  reply = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: broken\n\n"));
        },
        cancel() {
          cancelled.resolve();
        },
      }),
    );
  await expect(
    backend.events({
      after: 0,
      epoch: "e1",
      signal: new AbortController().signal,
      onState: () => undefined,
      onBatch: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "malformed_response" });
  await cancelled.promise;
});

test("byte-at-a-time CRLF frames deliver a batch", async () => {
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify([
      {
        sequence: 11,
        at: run.createdAt,
        txn: "t11",
        entity: "run",
        kind: "claimed",
        runId: run.id,
        record: run,
      },
    ])}\r\n\r\n`,
  );

  let index = 0;
  reply = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(1);

          if (index === bytes.length) {
            controller.close();

            return;
          }

          controller.enqueue(bytes.slice(index, ++index));
        },
      }),
    );
  const controller = new AbortController();
  const batches: number[][] = [];
  await backend.events({
    after: 10,
    epoch: "e1",
    signal: controller.signal,
    onState: () => undefined,
    onBatch: (batch) => {
      batches.push(batch.map((item) => item.sequence));
      controller.abort();
    },
  });
  expect(batches).toEqual([[11]]);
});

test("three empty EOFs back off for 500, 1000, then 2000 ms", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let attempts = 0;

  reply = () => {
    attempts++;

    return new Response("");
  };

  const backoff = localHttpBackend({
    baseUrl: server.url.origin,
    token: "secret",
    pause: async (ms) => {
      delays.push(ms);

      if (delays.length === 3) {
        controller.abort();
      }
    },
  });

  await backoff.events({
    after: 0,
    epoch: "e1",
    signal: controller.signal,
    onState: () => undefined,
    onBatch: () => undefined,
  });
  expect(delays).toEqual([500, 1000, 2000]);
  expect(attempts).toBe(3);
});

test("snapshot HTTP requests stop when their signal is aborted", async () => {
  const cancelled = Promise.withResolvers<void>();
  const body = Promise.withResolvers<void>();

  reply = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          body.resolve();
        },
        cancel() {
          cancelled.resolve();
        },
      }),
    );

  const controller = new AbortController();
  const requested = backend.call("run", { params: { id: run.id } }, controller.signal);
  await body.promise;
  controller.abort();
  await expect(requested).rejects.toMatchObject({ name: "AbortError" });
  await cancelled.promise;
});

test("session cursor uses its route schema and waiting booleans survive URL encoding", async () => {
  reply = () => Response.json({ cursor: 42, epoch: "session" });
  expect(await backend.call("cursor", {}, AbortSignal.timeout(1000))).toEqual({
    cursor: 42,
    epoch: "session",
  });
  expect(last()?.path).toBe("/api/cursor");
  reply = () => Response.json({ runs: [], next: null });
  await backend.call("runs", { query: { status: "suspended", waiting: true } });
  expect(last()?.path).toBe("/api/runs?status=suspended&waiting=true");
  reply = () => Response.json({ cursor: "bad", epoch: "session" });
  await expect(backend.call("cursor", {}, AbortSignal.timeout(1000))).rejects.toMatchObject({
    code: "malformed_response",
  });
});

test("the Promise bridge preserves the caller's abort reason even when an operation fails", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture abort reason");

  const operation = Effect.sync(() => controller.abort(reason)).pipe(
    Effect.andThen(Effect.fail(new BackendError("unreachable"))),
  );

  await expect(runRequest(operation, controller.signal)).rejects.toBe(reason);
});
