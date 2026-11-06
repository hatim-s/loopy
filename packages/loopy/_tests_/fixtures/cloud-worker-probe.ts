import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { ArtifactStorage } from "../../../../apps/cloud/src/artifacts/storage";
import { DurableSqlDriver } from "../../../../apps/cloud/src/sql-driver";
import { decodeBoundary, nodeIdSchema } from "../../src/contract";
import type { RunRecord, StoreEffect } from "../../src/core";
import { EVENT_RETENTION } from "../../src/store/event-outbox";
import { SqlRunStore } from "../../src/store/portable";
import { paginationResponse } from "./cloud-pagination-probe";

const at = "2026-10-22T00:00:00.000Z";

const key = { runId: "run", nodeId: decodeBoundary(nodeIdSchema)("approval"), scope: [] };

function run(id = "run"): RunRecord {
  return {
    id,
    slug: "probe",
    revision: "a".repeat(64),
    workspace: "probe",
    input: {},
    status: "queued",
    createdAt: at,
    updatedAt: at,
  };
}

function logs(): StoreEffect[] {
  return ["first", "second"].map((message) => ({
    kind: "write_log",
    executionKey: key,
    attempt: 1,
    at,
    log: { message, data: null },
  }));
}

async function failure<T>(work: () => T): Promise<string> {
  try {
    await work();

    return "did not reject";
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 400) : "non-error rejection";
  }
}

export class CloudWorkerProbe {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { ARTIFACTS: R2Bucket },
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname.startsWith("/pagination/")) {
        return await paginationResponse(request, this.ctx, this.env.ARTIFACTS);
      }

      return Response.json(await this.command(new URL(request.url).pathname));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message.slice(0, 400) : "probe failed" },
        { status: 500 },
      );
    }
  }

  private async command(path: string) {
    if (path === "/r2") {
      const storage = new ArtifactStorage(this.env.ARTIFACTS, "probe");
      await Effect.runPromise(storage.put("immutable", "original"));
      await Effect.runPromise(storage.put("immutable", "replacement"));

      const conditional = await this.env.ARTIFACTS.put("workspaces/probe/immutable", "third", {
        onlyIf: { etagDoesNotMatch: "*" },
      });

      const other = new ArtifactStorage(this.env.ARTIFACTS, "other");

      return {
        value: new TextDecoder().decode(
          (await Effect.runPromise(storage.read("immutable", 8))) ?? undefined,
        ),
        conditionalRejected: conditional === null,
        other: await Effect.runPromise(other.read("immutable", 8)),
        oversized: await failure(() => Effect.runPromise(storage.read("immutable", 7))),
      };
    }

    await this.ctx.storage.put("synthetic-marker", "retained");
    let tick = Date.parse(at);
    const driver = new DurableSqlDriver(this.ctx.storage);

    const store = new SqlRunStore(driver, {
      owner: { identity: { pid: null, host: "probe" }, isAlive: () => false },
      now: () => tick++,
      leaseMs: 1000,
    });

    if (path === "/reopen") {
      return {
        cursor: await Effect.runPromise(store.eventCursor()),
        marker: await this.ctx.storage.get<string>("synthetic-marker"),
        run: await Effect.runPromise(store.getRun("run")),
      };
    }

    if (path === "/rollback") {
      await Effect.runPromise(store.createRun(run()));
      await Effect.runPromise(store.claim("run", "owner"));
      const before = await Effect.runPromise(store.eventCursor());
      const published: unknown[] = [];
      store.subscribe((events) => published.push(...events));

      const error = await failure(() =>
        Effect.runPromise(
          store.apply({
            runId: "run",
            token: "owner",
            effects: [...logs(), { kind: "schedule_retry", at: "invalid-date" }],
          }),
        ),
      );

      const snapshot = await Effect.runPromise(store.snapshotRun("run"));

      return {
        error,
        before,
        after: await Effect.runPromise(store.eventCursor()),
        logs: snapshot?.logs,
        published,
        usage: this.ctx.storage.sql.exec("SELECT * FROM log_attempt_usage").toArray(),
      };
    }

    if (path === "/owners") {
      await Effect.runPromise(store.createRun(run()));
      await Effect.runPromise(store.claim("run", "first"));
      const live = await failure(() => Effect.runPromise(store.claim("run", "second")));
      tick += 1001;
      await Effect.runPromise(store.claim("run", "second"));
      const before = await Effect.runPromise(store.eventCursor());

      const stale = await failure(() =>
        Effect.runPromise(store.apply({ runId: "run", token: "first", effects: logs() })),
      );

      const heartbeat = await Effect.runPromise(store.heartbeat("run", "first"));

      const reopened = new SqlRunStore(driver, {
        owner: { identity: { pid: null, host: "reopened" }, isAlive: () => false },
      });

      return {
        live,
        stale,
        heartbeat,
        before,
        after: await Effect.runPromise(reopened.eventCursor()),
        run: await Effect.runPromise(reopened.getRun("run")),
        marker: await this.ctx.storage.get<string>("synthetic-marker"),
        logs: await Effect.runPromise(reopened.getLogs("run")),
      };
    }

    if (path === "/schedules") {
      const schedule = await Effect.runPromise(
        store.putSchedule({
          workspace: "probe",
          slug: "probe",
          cron: "* * * * *",
          tz: "UTC",
          input: {},
          enabled: true,
          nextFireAt: at,
        }),
      );

      await Effect.runPromise(store.createRun(run()));

      const fire = {
        workspace: "probe",
        slug: "probe",
        version: schedule.version,
        fireKey: `probe@${at}`,
        nextFireAt: "2026-10-22T00:01:00.000Z",
        run: run(),
      };

      const before = await Effect.runPromise(store.eventCursor());
      const error = await failure(() => Effect.runPromise(store.fireSchedule(fire)));

      const rolledBack = {
        schedule: (await Effect.runPromise(store.listSchedules()))[0],
        cursor: await Effect.runPromise(store.eventCursor()),
      };

      const fired = await Effect.runPromise(store.fireSchedule({ ...fire, run: run("scheduled") }));
      const cursor = await Effect.runPromise(store.eventCursor());

      const duplicate = await Effect.runPromise(
        store.fireSchedule({ ...fire, run: run("duplicate") }),
      );

      return {
        error,
        before,
        rolledBack,
        fired,
        duplicate,
        cursor,
        after: await Effect.runPromise(store.eventCursor()),
        runs: (await Effect.runPromise(store.listRuns())).map(({ id }) => id),
        events: await Effect.runPromise(store.events(before.cursor, 10)),
      };
    }

    if (path === "/waits") {
      await Effect.runPromise(store.createRun(run()));
      await Effect.runPromise(store.claim("run", "owner"));
      await Effect.runPromise(
        store.apply({
          runId: "run",
          token: "owner",
          effects: [
            {
              kind: "write_node_run",
              nodeRun: {
                key,
                attempt: 1,
                maxAttempts: 1,
                receipt: "none",
                startedAt: at,
                status: "waiting",
                wakeAt: "2026-10-22T01:00:00.000Z",
              },
            },
            {
              kind: "register_wait",
              executionKey: key,
              name: "approve",
              payload: { kind: "record", fields: { approved: "boolean" } },
              at,
            },
            { kind: "suspend_run", wakeAt: "2026-10-22T01:00:00.000Z", at },
          ],
        }),
      );
      const wait = (await Effect.runPromise(store.getWaits("run")))[0];

      if (!wait) {
        throw new Error("Wait was not persisted.");
      }

      const before = await Effect.runPromise(store.eventCursor());

      const invalid = await Effect.runPromise(
        store.resolveWait({
          token: wait.token,
          payload: { approved: "invalid" },
          at,
        }),
      );

      const unchanged = await Effect.runPromise(store.eventCursor());

      const results = await Promise.all(
        [true, false].map((payload) =>
          Effect.runPromise(
            store.resolveWait({ token: wait.token, payload: { approved: payload }, at }),
          ),
        ),
      );

      const events = await Effect.runPromise(store.events(before.cursor, 20));

      return {
        invalid,
        before,
        unchanged,
        results,
        events,
        transactions: [...new Set(events.map((event) => event.txn))].length,
        snapshot: await Effect.runPromise(store.snapshotRun("run")),
      };
    }

    if (path === "/prune") {
      await Effect.runPromise(store.createRun(run()));
      await Effect.runPromise(store.claim("run", "owner"));
      await Effect.runPromise(store.apply({ runId: "run", token: "owner", effects: logs() }));
      const events = await Effect.runPromise(store.events(0, 10));
      const tail = events.at(-1);

      if (!tail) {
        throw new Error("Missing transaction tail.");
      }

      const removed = await Effect.runPromise(
        store.pruneEvents(new Date(Date.parse(tail.at) + EVENT_RETENTION.maxAgeMs).toISOString()),
      );

      const empty = await Effect.runPromise(store.events(0, 10));
      const cursor = await Effect.runPromise(store.eventCursor());
      await Effect.runPromise(store.heartbeat("run", "owner"));

      return {
        events,
        removed,
        empty,
        cursor,
        next: await Effect.runPromise(store.events(cursor.cursor, 10)),
        oldest: await Effect.runPromise(store.oldestEventSequence()),
      };
    }

    throw new Error("Unknown bounded probe command.");
  }
}

export default {
  fetch(): Response {
    return new Response("Probe requires its Durable Object binding.", { status: 404 });
  },
};
