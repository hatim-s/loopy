import { afterAll, expect, test } from "bun:test";
import type { RunView } from "loopy/contract";
import { BackendError } from "../src/backend/backend.ts";
import { localHttpBackend } from "../src/backend/local-http.ts";

const run: RunView = {
  id: "run/1",
  slug: "triage",
  workspace: "/work",
  loopy: { slug: "triage", description: null },
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

const backend = localHttpBackend({ origin: server.url.origin, token: "secret" });

function last(): Seen | undefined {
  return seen.at(-1);
}

test("each call uses the method and path from the route table, with the token", async () => {
  reply = () => Response.json(run);

  await backend.resumeRun("run/1");
  expect(last()).toEqual({
    method: "POST",
    path: "/api/runs/run%2F1/resume",
    authorization: "Bearer secret",
    body: "",
  });

  await backend.resolveHook("tok", { approved: true });
  expect(last()?.method).toBe("POST");
  expect(last()?.path).toBe("/api/hooks/tok");
  expect(JSON.parse(last()?.body ?? "")).toEqual({ payload: { approved: true } });

  reply = () => Response.json([run]);
  await backend.runs({ slug: "triage", limit: 20 });
  expect(last()?.method).toBe("GET");
  expect(last()?.path).toBe("/api/runs?slug=triage&limit=20");

  reply = () => Response.json([]);
  await backend.logs("run/1", 7);
  expect(last()?.path).toBe("/api/runs/run%2F1/logs?after=7");
});

test("a response that fails the route schema is rejected", async () => {
  reply = () => Response.json({ ...run, status: "exploded" });

  const failure = backend.cancelRun("run/1");

  await expect(failure).rejects.toBeInstanceOf(BackendError);
  await expect(failure).rejects.toMatchObject({ code: "malformed_response" });
});

test("an error body becomes a BackendError with the server's code and message", async () => {
  reply = () =>
    Response.json(
      { error: { code: "not_claimable", message: "Run is finished." } },
      { status: 409 },
    );

  await expect(backend.resumeRun("run/1")).rejects.toEqual(
    new BackendError("not_claimable", "Run is finished."),
  );
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
