import { afterAll, expect, test } from "bun:test";
import { BackendError } from "../src/backend/backend.ts";
import { backendConfigSchema } from "../src/backend/config.ts";
import { TRIAGE_V1 } from "../src/backend/demo-graphs.ts";
import { legacyHttpBackend } from "../src/backend/legacy-http.ts";
import { localHttpBackend } from "../src/backend/local-http.ts";
import { legacyLoopy, legacySchedule, legacySnapshot } from "./legacy-fixtures.ts";

type Seen = { method: string; path: string; authorization: string | null; body: string };

const seen: Seen[] = [];

let reply: () => Response = () => Response.json(legacySnapshot);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname + url.search,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });

    return reply();
  },
});

afterAll(() => server.stop(true));

const connection = { origin: server.url.origin, token: "fixture-auth" };

const backend = legacyHttpBackend({ ...connection, workspace: "/configured/cwd" });

const native = localHttpBackend(connection);

test("legacy selection requires its run directory and unknown or mixed modes fail", () => {
  expect(() => backendConfigSchema.parse({ mode: "legacy" })).toThrow("Set VITE_LEGACY_WORKSPACE");
  expect(() => backendConfigSchema.parse({ mode: "legacy", workspace: "  " })).toThrow("must name");
  expect(backendConfigSchema.parse({ mode: "legacy", workspace: "/configured/cwd" })).toEqual({
    mode: "legacy",
    workspace: "/configured/cwd",
  });

  for (const mode of ["http", "fake"] as const) {
    expect(backendConfigSchema.parse({ mode })).toEqual({ mode });
    expect(backendConfigSchema.safeParse({ mode, workspace: "/legacy" }).success).toBe(false);
  }

  expect(backendConfigSchema.safeParse({ mode: "automatic" }).success).toBe(false);
});

test("legacy inventory gains the configured run directory and retains declared scope and history", async () => {
  reply = () => Response.json([legacyLoopy]);
  expect(await backend.loopies()).toEqual([{ ...legacyLoopy, workspace: "/configured/cwd" }]);
  expect(seen.at(-1)?.path).toBe("/api/loopies");
  await expect(native.loopies()).rejects.toMatchObject({ code: "malformed_response" });

  reply = () => Response.json([{ ...legacyLoopy, unexpected: true }]);
  await expect(backend.loopies()).rejects.toMatchObject({ code: "malformed_response" });
});

test("legacy snapshots preserve recorded steps, logs, hooks and the run's actual workspace", async () => {
  reply = () => Response.json(legacySnapshot);
  expect(await backend.run("recorded/1", AbortSignal.timeout(1000))).toEqual({
    ...legacySnapshot,
    nodeRuns: [],
  });
  expect(seen.at(-1)?.path).toBe("/api/runs/recorded%2F1");
  await expect(native.run("recorded/1", AbortSignal.timeout(1000))).rejects.toMatchObject({
    code: "malformed_response",
  });

  reply = () => Response.json({ ...legacySnapshot, nodeRuns: [] });
  await expect(backend.run("recorded/1", AbortSignal.timeout(1000))).rejects.toMatchObject({
    code: "malformed_response",
  });
  reply = () =>
    Response.json({ ...legacySnapshot, steps: [{ ...legacySnapshot.steps[0], attempt: -1 }] });
  await expect(backend.run("recorded/1", AbortSignal.timeout(1000))).rejects.toMatchObject({
    code: "malformed_response",
  });
});

test("legacy graph absence is explicit and makes no request; native graph errors remain errors", async () => {
  expect(backend.graphSupport).toBe("legacy_unavailable");
  const count = seen.length;
  await expect(backend.loopyGraph("approval", "/configured/cwd")).rejects.toEqual(
    new BackendError("legacy_unavailable"),
  );
  await expect(backend.runGraph("recorded/1")).rejects.toMatchObject({
    code: "legacy_unavailable",
  });
  expect(seen.length).toBe(count);
  expect(native.graphSupport).toBe("available");

  for (const [status, code] of [
    [404, "not_found"],
    [401, "unauthorized"],
  ] as const) {
    reply = () => Response.json({ error: { code, message: "Fixture error." } }, { status });
    await expect(native.runGraph("recorded/1")).rejects.toMatchObject({ code });
    await expect(backend.loopies()).rejects.toMatchObject({ code });
  }

  reply = () => Response.json({ missing: "graph" });
  await expect(native.runGraph("recorded/1")).rejects.toMatchObject({ code: "malformed_response" });
  expect(native.graphSupport).toBe("available");
});

test("legacy reads use exactly the installed route queries and normalize schedule counters", async () => {
  reply = () => Response.json([legacySchedule]);
  const { revision, ...schedule } = legacySchedule;
  expect(await backend.schedules()).toEqual([{ ...schedule, version: revision }]);
  expect(seen.at(-1)?.path).toBe("/api/schedules");

  reply = () => Response.json([legacySnapshot.run]);
  await backend.runs({ slug: "approval", waiting: false, limit: 200 });
  expect(seen.at(-1)?.path).toBe("/api/runs?slug=approval&waiting=false&limit=200");
  reply = () => Response.json(legacySnapshot.logs);
  expect(await backend.logs("recorded/1", 0)).toEqual(legacySnapshot.logs);
  expect(seen.at(-1)?.path).toBe("/api/runs/recorded%2F1/logs?after=0");

  reply = () => Response.json({ cursor: 10, epoch: "legacy-epoch" });
  expect(await backend.cursor(AbortSignal.timeout(1000))).toEqual({
    cursor: 10,
    epoch: "legacy-epoch",
  });
  expect(seen.at(-1)?.path).toBe("/api/cursor");
});

test("native graph success and network failure retain the explicit graph capability", async () => {
  reply = () => Response.json(TRIAGE_V1);
  expect(await native.runGraph("recorded/1")).toEqual(TRIAGE_V1);
  expect(await native.loopyGraph("triage-inbox", "/graph/cwd")).toEqual(TRIAGE_V1);
  expect(seen.at(-1)?.path).toBe("/api/loopies/triage-inbox/graph?workspace=%2Fgraph%2Fcwd");

  const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
  const disconnected = localHttpBackend({ origin: closed.url.origin, token: null });
  closed.stop(true);
  await expect(disconnected.runGraph("recorded/1")).rejects.toMatchObject({ code: "unreachable" });
  expect(disconnected.graphSupport).toBe("available");
});

test("legacy mutations stay on HTTP, pin configured cwd for starts and omit unsupported queries", async () => {
  reply = () => Response.json(legacySnapshot.run);
  const start = seen.length;
  await backend.startRun("approval", { request: "fixture" }, "/caller/cwd");
  await backend.resumeRun("recorded/1");
  await backend.cancelRun("recorded/1");
  await backend.resolveHook("fixture/hook", { approved: true });

  reply = () => Response.json(legacySchedule);
  const { revision, ...schedule } = legacySchedule;
  expect(await backend.putSchedule("approval", { cron: "@hourly" })).toEqual({
    ...schedule,
    version: revision,
  });
  expect(await backend.setScheduleEnabled("approval", false)).toEqual({
    ...schedule,
    version: revision,
  });
  reply = () => Response.json({ deleted: true });
  await backend.deleteSchedule("approval");
  expect(seen.slice(start)).toEqual([
    {
      method: "POST",
      path: "/api/loopies/approval/runs",
      authorization: "Bearer fixture-auth",
      body: JSON.stringify({ input: { request: "fixture" }, workspace: "/configured/cwd" }),
    },
    {
      method: "POST",
      path: "/api/runs/recorded%2F1/resume",
      authorization: "Bearer fixture-auth",
      body: "",
    },
    {
      method: "POST",
      path: "/api/runs/recorded%2F1/cancel",
      authorization: "Bearer fixture-auth",
      body: "",
    },
    {
      method: "POST",
      path: "/api/hooks/fixture%2Fhook",
      authorization: "Bearer fixture-auth",
      body: JSON.stringify({ payload: { approved: true } }),
    },
    {
      method: "PUT",
      path: "/api/loopies/approval/schedule",
      authorization: "Bearer fixture-auth",
      body: JSON.stringify({ cron: "@hourly" }),
    },
    {
      method: "POST",
      path: "/api/loopies/approval/schedule/enabled",
      authorization: "Bearer fixture-auth",
      body: JSON.stringify({ enabled: false }),
    },
    {
      method: "DELETE",
      path: "/api/loopies/approval/schedule",
      authorization: "Bearer fixture-auth",
      body: "",
    },
  ]);
});
