import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  decodeRouteResponse,
  type RouteInput,
  type RouteName,
  routeRequest,
  routes,
} from "@loopy/contract";
import { Effect } from "effect";
import { makeLocalService } from "../src/local";
import { startServer } from "../src/local/server/start-server";
import { openRunStore } from "../src/store";
import { compiledBody } from "./fixtures/compiled";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { onCleanup, runScoped } from "./fixtures/test-scope";

const SLUG = "same-slug";

/** One saved loopy under the same slug in a default workspace A and a second project B. */
async function fixture() {
  const root = qualityTestRoot("workspaces");
  const home = join(root, "home");
  const workspaceA = join(root, "project-a");
  const workspaceB = join(root, "project-b");

  for (const workspace of [workspaceA, workspaceB]) {
    mkdirSync(join(workspace, ".loopy", "loopies"), { recursive: true });
  }

  const store = await runScoped(openRunStore(home));
  const service = makeLocalService({ store, home });

  for (const workspace of [workspaceA, workspaceB]) {
    const body = await compiledBody(SLUG, join(workspaceA, `${SLUG}.loopy.ts`), { workspace });
    await Effect.runPromise(service.putLoopy(SLUG, body));
  }

  const token = "isolated-workspace-test";

  const server = startServer({
    service,
    store,
    cwd: workspaceA,
    token,
    port: 0,
    assets: join(root, "assets"),
    daemon: { pid: process.pid, startedAt: new Date().toISOString(), concurrency: 1 },
  });

  onCleanup(() => server.stop());
  const baseUrl = new URL(server.url).origin;

  const call = async <K extends RouteName>(name: K, input: RouteInput<(typeof routes)[K]>) => {
    const request = routeRequest(routes[name], input);

    const response = await fetch(`${baseUrl}${request.url}`, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${token}` },
      body: request.body,
    });

    const outcome = decodeRouteResponse(routes[name], response.status, await response.text());

    if (outcome.kind !== "ok") {
      throw new Error(`${name} answered ${response.status}: ${JSON.stringify(outcome)}`);
    }

    return outcome.value;
  };

  return { baseUrl, call, service, store, workspaceA, workspaceB };
}

const schedule = { cron: "@daily", tz: "UTC", input: {}, enabled: true };

test("HTTP schedule edits for one slug stay inside the workspace they name", async () => {
  const { call, service, workspaceA, workspaceB } = await fixture();
  const a = await Effect.runPromise(service.putSchedule(SLUG, schedule, workspaceA));
  const inB = { params: { slug: SLUG }, query: { workspace: workspaceB } };
  const b = await call("putSchedule", { ...inB, body: { ...schedule, cron: "@hourly" } });

  expect(a.workspace).toBe(workspaceA);
  expect(b.workspace).toBe(workspaceB);
  expect(await call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);
  expect(await call("schedules", { query: { workspace: workspaceB } })).toEqual([b]);

  await call("putSchedule", { ...inB, body: { cron: "@weekly", input: schedule.input } });
  const disabled = await call("setScheduleEnabled", { ...inB, body: { enabled: false } });
  expect(disabled).toMatchObject({ cron: "@weekly", enabled: false, version: 3 });
  expect(await call("schedules", { query: { workspace: workspaceB } })).toEqual([disabled]);

  await call("deleteSchedule", inB);
  expect(await call("schedules", { query: { workspace: workspaceB } })).toEqual([]);
  expect(await call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);
});

test("schedule overview and loopy rows list each workspace beside the other's same slug", async () => {
  const { baseUrl, call, service, store, workspaceA, workspaceB } = await fixture();
  const inB = { params: { slug: SLUG }, query: { workspace: workspaceB } };
  const b = await call("putSchedule", { ...inB, body: schedule });

  expect((await fetch(`${baseUrl}/api/schedules/overview`)).status).toBe(401);
  expect((await call("loopies", {})).map((row) => row.workspace).sort()).toEqual(
    [workspaceA, workspaceB].sort(),
  );
  expect(await call("schedules", { query: { workspace: workspaceA } })).toEqual([]);
  expect(await call("scheduleOverview", {})).toEqual({
    workspaces: [workspaceB],
    active: 1,
    next: [
      { workspace: workspaceB, slug: b.slug, cron: b.cron, tz: b.tz, nextFireAt: b.nextFireAt },
    ],
  });

  const a = await Effect.runPromise(
    service.putSchedule(SLUG, { ...schedule, enabled: false }, workspaceA),
  );

  await call("putSchedule", { ...inB, body: { ...schedule, cron: "@hourly" } });
  expect((await call("scheduleOverview", {})).next[0]?.cron).toBe("@hourly");

  await call("setScheduleEnabled", { ...inB, body: { enabled: false } });
  expect(await call("scheduleOverview", {})).toEqual({
    workspaces: [workspaceA, workspaceB],
    active: 0,
    next: [],
  });
  expect(await call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);

  await call("deleteSchedule", inB);
  expect(await call("scheduleOverview", {})).toEqual({
    workspaces: [workspaceA],
    active: 0,
    next: [],
  });

  const unscheduled = (await call("loopies", { query: { workspace: workspaceB } })).filter(
    (row) => row.workspace === workspaceB && row.schedule === null,
  );

  expect(unscheduled.map((row) => row.slug)).toEqual([SLUG]);
  const recreated = await call("putSchedule", { ...inB, body: schedule });
  expect(recreated.workspace).toBe(workspaceB);
  expect(await call("schedules", { query: { workspace: workspaceA } })).toEqual([a]);
  await call("deleteSchedule", inB);

  for (let index = 0; index < 12; index++) {
    await Effect.runPromise(
      store.putSchedule({
        workspace: workspaceB,
        cron: b.cron,
        tz: b.tz,
        input: schedule.input,
        enabled: true,
        slug: `bounded-${index}`,
        nextFireAt: `2030-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
  }

  const bounded = await call("scheduleOverview", {});
  expect(bounded.active).toBe(12);
  expect(bounded.next.map((row) => row.slug)).toEqual(
    [...Array(10).keys()].map((index) => `bounded-${index}`),
  );
  expect(JSON.stringify(bounded)).not.toContain('"input"');
});
