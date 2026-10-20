import { afterAll, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { RunSnapshotView, ScheduleView, ServerEvent } from "loopy/contract";
import { legacyHttpBackend } from "../src/backend/legacy-http.ts";
import { keys } from "../src/lib/keys.ts";
import { applyBatch } from "../src/lib/stream.ts";
import { at, legacySchedule, legacySnapshot } from "./legacy-fixtures.ts";

const seen: string[] = [];

let reply: () => Response = () => new Response("");

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    seen.push(`${url.pathname}${url.search}`);
    expect(request.headers.get("authorization")).toBe("Bearer fixture-auth");

    return reply();
  },
});

afterAll(() => server.stop(true));

const backend = legacyHttpBackend({
  origin: server.url.origin,
  token: "fixture-auth",
  workspace: "/configured/cwd",
});

test("legacy SSE normalizes counters, preserves history and invalidates summaries before resuming its cursor", async () => {
  const client = new QueryClient();
  client.setQueryData(keys.loopies, []);
  client.setQueryData(keys.run(legacySnapshot.run.id), {
    ...legacySnapshot,
    nodeRuns: [],
    steps: [],
    logs: [],
    hooks: [],
  });
  const { revision, lastFireKey, ...record } = legacySchedule;
  client.setQueryData(keys.schedules, [{ ...record, version: revision, lastFireKey }]);

  const batch = [
    {
      sequence: 11,
      at,
      txn: "fixture-txn",
      runId: null,
      entity: "schedule",
      kind: "saved",
      record: { ...record, revision: revision + 1 },
    },
    {
      sequence: 12,
      at,
      txn: "fixture-txn",
      runId: legacySnapshot.run.id,
      entity: "step",
      kind: "succeeded",
      record: legacySnapshot.steps[0],
    },
    {
      sequence: 13,
      at,
      txn: "fixture-txn",
      runId: legacySnapshot.run.id,
      entity: "log",
      kind: "written",
      record: legacySnapshot.logs[0],
    },
    {
      sequence: 14,
      at,
      txn: "fixture-txn",
      runId: legacySnapshot.run.id,
      entity: "hook",
      kind: "resolved",
      record: legacySnapshot.hooks[0],
    },
  ];

  let requests = 0;
  reply = () => {
    requests++;

    if (requests > 1) {
      return Response.json(
        { error: { code: "stale_cursor", message: "Refetch." } },
        { status: 410 },
      );
    }

    const text = `data: ${JSON.stringify(batch)}\r\n\r\n`;

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text.slice(0, 13)));
          controller.enqueue(new TextEncoder().encode(text.slice(13)));
          controller.close();
        },
      }),
    );
  };

  const batches: ServerEvent[][] = [];

  const end = await backend.events({
    after: 10,
    epoch: "legacy-epoch",
    signal: AbortSignal.timeout(3000),
    onState: () => {},
    onBatch: (events) => {
      batches.push(events);
      applyBatch(client, events);
    },
  });

  expect(end).toBe("reset");
  expect(seen.slice(-2)).toEqual([
    "/api/events?after=10&epoch=legacy-epoch",
    "/api/events?after=14&epoch=legacy-epoch",
  ]);
  expect(batches[0]?.[0]).toMatchObject({ record: { version: revision + 1 } });
  expect(batches[0]?.[0]?.record).not.toHaveProperty("revision");
  expect(client.getQueryData<ScheduleView[]>(keys.schedules)?.[0]?.version).toBe(revision + 1);
  expect(client.getQueryState(keys.loopies)?.isInvalidated).toBe(true);
  expect(client.getQueryData<RunSnapshotView>(keys.run(legacySnapshot.run.id))).toEqual({
    ...legacySnapshot,
    nodeRuns: [],
    cursor: 14,
  });
});

test("legacy SSE rejects malformed counters and native schedule records without guessing", async () => {
  const { revision, ...record } = legacySchedule;

  for (const schedule of [
    { ...record, lastFireKey: undefined, revision: "7" },
    { ...record, lastFireKey: undefined, version: revision },
  ]) {
    reply = () =>
      new Response(
        `data: ${JSON.stringify([
          {
            sequence: 11,
            at,
            txn: "fixture-txn",
            runId: null,
            entity: "schedule",
            kind: "saved",
            record: schedule,
          },
        ])}\n\n`,
      );
    const states: string[] = [];
    await expect(
      backend.events({
        after: 10,
        epoch: "legacy-epoch",
        signal: AbortSignal.timeout(1000),
        onBatch: () => {},
        onState: (state) => states.push(state),
      }),
    ).rejects.toMatchObject({ code: "malformed_response" });
    expect(states.at(-1)).toBe("stale");
  }
});
