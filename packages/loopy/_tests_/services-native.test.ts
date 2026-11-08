import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeBoundary, nodeIdSchema } from "@loopy/contract";
import { StorageError } from "@loopy/core";
import { makeService, ServiceError } from "@loopy/runtime/service";
import { makeSqliteRunStore } from "@loopy/runtime/store";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { Registry } from "../../runtime/src/local/registry";
import { startServer } from "../../runtime/src/local/server/start-server";
import { makeLocalService } from "../../runtime/src/local/service";
import { SecretStore } from "../../runtime/src/os/secrets";
import { compiledBody } from "./compiled-fixture";
import { qualityTestRoot } from "./fixtures/quality-test-root";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function fixture(options: { concurrency?: number } = {}) {
  const causes: Cause.Cause<unknown>[] = [];
  const root = await qualityTestRoot("services-effect");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);
  const source = join(root, "workflow.ts");
  await writeFile(source, "export default null;");
  const registry = await Effect.runPromise(Registry.make(home, root));
  const scope = Scope.makeUnsafe();
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));

  const store = await Effect.runPromise(
    makeSqliteRunStore(join(home, "runs.sqlite")).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const body = await compiledBody("workflow", source);
  await Effect.runPromise(registry.save(body));

  const service = makeLocalService({
    store,
    home,
    clock: { now: () => Date.parse("2026-10-17T00:00:00.000Z") },
  });

  const server = startServer({
    service,
    store,
    token: "fixture-token",
    cwd: root,
    port: 0,
    assets: join(root, "assets"),
    daemon: {
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      concurrency: options.concurrency ?? 4,
    },
    onError: (cause) => causes.push(cause),
  });

  cleanups.push(() => server.stop());

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}/api${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer fixture-token",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

  return { root, home, store, service, request, causes };
}

test("HTTP preserves input rejection, durable queued admission and terminal cancellation guards", async () => {
  const f = await fixture();

  const bad = await f.request("/loopies/workflow/runs", {
    method: "POST",
    body: JSON.stringify({ input: {}, unexpected: true }),
  });

  expect(bad.status).toBe(400);
  expect(
    await Effect.runPromise(f.store.queryRuns({ limit: 200, now: new Date().toISOString() })),
  ).toEqual([]);
  const run = await Effect.runPromise(f.service.startRun("workflow", {}, f.root));
  expect(run.status).toBe("queued");
  await Effect.runPromise(f.store.claim(run.id, "fixture-owner"));
  const at = "2026-10-17T00:00:00.000Z";
  await Effect.runPromise(
    f.store.apply({
      runId: run.id,
      token: "fixture-owner",
      effects: [{ kind: "finish_run", outcome: { status: "succeeded", output: null }, at }],
    }),
  );
  await Effect.runPromise(f.store.release(run.id, "fixture-owner"));
  const cancelled = await Effect.runPromiseExit(f.service.cancelRun(run.id));
  expect(Exit.isFailure(cancelled)).toBe(true);
  expect((await f.request(`/runs/${run.id}`)).status).toBe(200);
  expect((await f.request("/runs/missing")).status).toBe(404);
});

test("storage outage stays internal and secrets never appear in HTTP failure bodies", async () => {
  const f = await fixture();
  f.store.getRun = () =>
    Effect.fail(
      new StorageError({
        operation: "read",
        reason: "unavailable",
        cause: new Error("private-password"),
      }),
    );
  const response = await f.request("/runs/missing/payload");
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private-password");
  const secrets = new SecretStore(f.home);
  await Effect.runPromise(secrets.set("TOKEN", "private-password"));
  expect(await Effect.runPromise(secrets.list())).toEqual(["TOKEN"]);
  expect(await Effect.runPromise(secrets.values(["TOKEN"]))).toEqual({ TOKEN: "private-password" });
  await Effect.runPromise(secrets.remove("TOKEN"));
  expect(await Effect.runPromise(secrets.list())).toEqual([]);
});

test("SSE replays complete transactions and rejects split and stale cursors", async () => {
  const f = await fixture();
  const run = await Effect.runPromise(f.service.startRun("workflow", {}, f.root));
  const cursor = await Effect.runPromise(f.service.cursor());
  const controller = new AbortController();

  const response = await f.request(`/events?after=0&epoch=${cursor.epoch}`, {
    signal: controller.signal,
  });

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let text = "";

  while (!text.includes("event: txn")) {
    const chunk = await reader.read();
    text += new TextDecoder().decode(chunk.value);
  }

  expect(text).toContain(run.id);
  await reader.cancel();
  controller.abort();
  expect((await f.request("/events?after=0&epoch=obsolete")).status).toBe(410);
});

test("schedules validate cron and timezone, advance versions and preserve input failures", async () => {
  const f = await fixture();

  const first = await Effect.runPromise(
    f.service.putSchedule("workflow", { cron: "* * * * *" }, f.root),
  );

  const second = await Effect.runPromise(f.service.setScheduleEnabled("workflow", false, f.root));
  expect(second.version).toBeGreaterThan(first.version);
  expect(second.enabled).toBe(false);

  const bad = await f.request("/loopies/workflow/schedule", {
    method: "PUT",
    body: JSON.stringify({ cron: "invalid" }),
  });

  expect(bad.status).toBe(400);
  expect((await Effect.runPromise(f.store.listSchedules()))[0]?.version).toBe(second.version);
  await Effect.runPromise(f.service.deleteSchedule("workflow", f.root));
  expect(await Effect.runPromise(f.store.listSchedules())).toEqual([]);
});

test("hook resolution is atomic and SSE refuses a cursor inside a commit", async () => {
  const f = await fixture();
  const run = await Effect.runPromise(f.service.startRun("workflow", {}, f.root));
  const at = "2026-10-17T00:00:00.000Z";
  await Effect.runPromise(f.store.claim(run.id, "fixture-owner"));
  const key = { runId: run.id, nodeId: decodeBoundary(nodeIdSchema)("0:hook"), scope: [] };
  await Effect.runPromise(
    f.store.apply({
      runId: run.id,
      token: "fixture-owner",
      effects: [
        {
          kind: "write_node_run",
          nodeRun: {
            key,
            attempt: 1,
            maxAttempts: 1,
            startedAt: at,
            status: "waiting",
            wakeAt: null,
            receipt: "none",
          },
        },
        {
          kind: "register_wait",
          executionKey: key,
          name: "approval",
          payload: { kind: "record", fields: { ok: "boolean" } },
          at,
        },
        { kind: "suspend_run", wakeAt: null },
      ],
    }),
  );
  const events = await Effect.runPromise(f.store.events(0, 100));
  const last = events.at(-1)!;
  const txn = events.filter((event) => event.txn === last.txn);
  expect(txn.length).toBeGreaterThan(1);
  const cursor = await Effect.runPromise(f.service.cursor());
  expect((await f.request(`/events?after=${txn[0]!.sequence}&epoch=${cursor.epoch}`)).status).toBe(
    410,
  );
  await Effect.runPromise(f.store.release(run.id, "fixture-owner"));
  const wait = (await Effect.runPromise(f.store.getWaits(run.id)))[0]!;

  const rejected = await Effect.runPromiseExit(
    f.service.resolveHook(wait.token, { ok: "invalid" }),
  );

  expect(Exit.isFailure(rejected)).toBe(true);

  const stored = async () =>
    (await Effect.runPromise(f.store.getWaits(run.id))).find((hook) => hook.token === wait.token);

  expect((await stored())?.resolvedAt).toBeFalsy();
  await Effect.runPromise(f.service.resolveHook(wait.token, { ok: true }));
  expect((await stored())?.resolvedAt).toBe(at);
  expect(
    Exit.isFailure(await Effect.runPromiseExit(f.service.resolveHook(wait.token, { ok: false }))),
  ).toBe(true);
});

test("successful cancellation commits and releases ownership", async () => {
  const f = await fixture();
  const run = await Effect.runPromise(f.service.startRun("workflow", {}, f.root));
  const response = await f.request(`/runs/${run.id}/cancel`, { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "cancelled", owner: null });
  expect(await Effect.runPromise(f.store.getRun(run.id))).toMatchObject({ status: "cancelled" });
  expect((await Effect.runPromise(f.store.getRun(run.id)))?.owner).toBeUndefined();
  expect((await f.request(`/runs/${run.id}/cancel`, { method: "POST" })).status).toBe(409);
});

for (const failApply of [false, true]) {
  test(`cancellation retains release failure with apply failure ${failApply}`, async () => {
    const f = await fixture();
    const run = await Effect.runPromise(f.service.startRun("workflow", {}, f.root));

    const releaseError = new StorageError({
      operation: "release",
      reason: "unavailable",
      cause: new Error("private release"),
    });

    const applyError = new StorageError({
      operation: "apply",
      reason: "unavailable",
      cause: new Error("private apply"),
    });

    f.store.release = () => Effect.fail(releaseError);

    if (failApply) {
      f.store.apply = () => Effect.fail(applyError);
    }

    const response = await f.request(`/runs/${run.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
    expect(f.causes).toHaveLength(1);
    const failures = f.causes[0]!.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    expect(failures).toEqual(failApply ? [applyError, releaseError] : [releaseError]);
  });
}

test("interruption after claim releases once after use stops and never persists cancellation", async () => {
  const f = await fixture();
  const run = await Effect.runPromise(f.service.startRun("workflow", {}, f.root));
  let stopped = false;
  let releases = 0;
  const release = f.store.release.bind(f.store);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        f.store.apply = () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                stopped = true;
              }),
            ),
          );
        f.store.release = (id, token) =>
          Effect.sync(() => {
            expect(stopped).toBe(true);
            releases++;
          }).pipe(Effect.andThen(release(id, token)));
        const fiber = yield* Effect.forkChild(f.service.cancelRun(run.id));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
  expect(releases).toBe(1);
  const persisted = await Effect.runPromise(f.store.getRun(run.id));
  expect(persisted?.status).not.toBe("cancelled");
  expect(persisted?.owner).toBeUndefined();
});

test("response contract defects report full Causes once and remain private", async () => {
  const f = await fixture({ concurrency: NaN });
  const response = await f.request("/daemon");
  expect(response.status).toBe(500);
  expect(f.causes).toHaveLength(1);
  expect(Cause.hasDies(f.causes[0]!)).toBe(true);
  expect(await response.text()).not.toContain("NaN");

  const secret = await f.request("/secrets/bad%20name", {
    method: "PUT",
    body: JSON.stringify({ value: "private-value" }),
  });

  expect(secret.status).toBe(400);
  const body = await secret.text();
  expect(body).not.toContain("private-value");
  expect(body).not.toContain(f.home);
});

test("an unfinished execution rejects cancellation before ownership changes", async () => {
  const f = await fixture();
  const run = await Effect.runPromise(f.service.startRun("workflow", {}, f.root));
  await Effect.runPromise(f.store.claim(run.id, "worker"));
  await Effect.runPromise(
    f.store.apply({
      runId: run.id,
      token: "worker",
      effects: [
        {
          kind: "write_node_run",
          nodeRun: {
            key: { runId: run.id, nodeId: decodeBoundary(nodeIdSchema)("0:work"), scope: [] },
            status: "running",
            attempt: 1,
            maxAttempts: 1,
            startedAt: "2026-10-17T00:00:00.000Z",
            receipt: "started",
          },
        },
      ],
    }),
  );
  await Effect.runPromise(f.store.release(run.id, "worker"));
  const before = await Effect.runPromise(f.store.dashboardSnapshot(run.id));
  await expect(Effect.runPromise(f.service.cancelRun(run.id))).rejects.toMatchObject({
    code: "not_claimable",
    message: "This run has an unfinished execution. Resume it before cancelling.",
  });
  expect(await Effect.runPromise(f.store.dashboardSnapshot(run.id))).toEqual(before);
});

test("native service and HTTP secret lists retain the store receiver and expose names only", async () => {
  const f = await fixture();
  expect(await Effect.runPromise(f.service.listSecrets())).toEqual([]);
  const empty = await f.request("/secrets");
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual([]);

  const saved = await f.request("/secrets/TOKEN", {
    method: "PUT",
    body: JSON.stringify({ value: "private-value" }),
  });

  expect(saved.status).toBe(200);
  expect(await Effect.runPromise(f.service.listSecrets())).toEqual(["TOKEN"]);
  const listed = await f.request("/secrets");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual(["TOKEN"]);
  expect(f.causes).toEqual([]);
});

test("typed unsupported secret and type-generation operations preserve HTTP501", async () => {
  const f = await fixture();

  const unsupported = () =>
    Effect.fail(new ServiceError("not_yet", "This host does not support this operation."));

  const service = makeService({
    store: f.store,
    clock: { now: Date.now },
    registry: () => Effect.die("unused registry"),
    canonicalWorkspace: () => Effect.die("unused workspace"),
    secrets: { list: unsupported, set: unsupported, remove: unsupported },
    generateTypes: unsupported,
  });

  const server = startServer({
    service,
    store: f.store,
    token: "fixture-token",
    cwd: f.root,
    port: 0,
    assets: join(f.root, "assets"),
    daemon: { pid: process.pid, startedAt: new Date(0).toISOString(), concurrency: 4 },
  });

  cleanups.push(() => server.stop());

  for (const [path, method, body] of [
    ["/secrets", "GET", undefined],
    ["/secrets/TOKEN", "PUT", { value: "private-value" }],
    ["/secrets/TOKEN", "DELETE", undefined],
    ["/types", "POST", { binary: "fixture-tool", path: [], name: null }],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${server.port}/api${path}`, {
      method,
      headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: { code: "not_yet", message: "This host does not support this operation." },
    });
  }
});
