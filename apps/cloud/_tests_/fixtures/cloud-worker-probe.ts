import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { decodeBoundary, nodeIdSchema } from "@loopy/contract";
import type { RunRecord, StoreEffect } from "@loopy/core";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect } from "effect";
import { runAt } from "../../../../packages/runtime/_tests_/fixtures/clock";
import { EVENT_RETENTION } from "../../../../packages/runtime/src/store/events";
import { ImmutableBucket, r2Key } from "../../src/artifacts/storage";
import { DurableSqlDriver } from "../../src/sql-driver";
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
      const storage = new ImmutableBucket(this.env.ARTIFACTS, r2Key.workspace("probe"));
      await Effect.runPromise(storage.put("immutable", "original"));
      await Effect.runPromise(storage.put("immutable", "replacement"));

      const conditional = await this.env.ARTIFACTS.put("workspaces/probe/immutable", "third", {
        onlyIf: { etagDoesNotMatch: "*" },
      });

      const other = new ImmutableBucket(this.env.ARTIFACTS, r2Key.workspace("other"));

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
    // The store reads time from Effect's Clock. Each reading advances one millisecond.
    const onClock = runAt(() => tick++);

    const driver = new DurableSqlDriver(this.ctx.storage);

    const store = new SqlRunStore(driver, {
      owner: { identity: { pid: null, host: "probe" }, isAlive: () => false },
      leaseMs: 1000,
    });

    if (path === "/reopen") {
      return {
        cursor: await onClock(store.eventCursor()),
        marker: await this.ctx.storage.get<string>("synthetic-marker"),
        run: await onClock(store.getRun("run")),
      };
    }

    if (path === "/rollback") {
      await onClock(store.createRun(run()));
      await onClock(store.claim("run", "owner"));
      const before = await onClock(store.eventCursor());
      const published: unknown[] = [];
      store.subscribe((events) => published.push(...events));

      const error = await failure(() =>
        onClock(
          store.apply({
            runId: "run",
            token: "owner",
            effects: [...logs(), { kind: "suspend_run", wakeAt: "invalid-date" }],
          }),
        ),
      );

      return {
        error,
        before,
        after: await onClock(store.eventCursor()),
        logs: await onClock(store.getLogs("run")),
        published,
        usage: this.ctx.storage.sql.exec("SELECT * FROM log_attempt_usage").toArray(),
      };
    }

    if (path === "/owners") {
      await onClock(store.createRun(run()));
      await onClock(store.claim("run", "first"));
      const live = await failure(() => onClock(store.claim("run", "second")));
      tick += 1001;
      await onClock(store.claim("run", "second"));
      const before = await onClock(store.eventCursor());

      const stale = await failure(() =>
        onClock(store.apply({ runId: "run", token: "first", effects: logs() })),
      );

      const heartbeat = await onClock(store.heartbeat("run", "first"));

      const reopened = new SqlRunStore(driver, {
        owner: { identity: { pid: null, host: "reopened" }, isAlive: () => false },
      });

      return {
        live,
        stale,
        heartbeat,
        before,
        after: await onClock(reopened.eventCursor()),
        run: await onClock(reopened.getRun("run")),
        marker: await this.ctx.storage.get<string>("synthetic-marker"),
        logs: await onClock(reopened.getLogs("run")),
      };
    }

    if (path === "/schedules") {
      const schedule = await onClock(
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

      await onClock(store.createRun(run()));

      const fire = { schedule, next: "2026-10-22T00:01:00.000Z", run: run() };

      const before = await onClock(store.eventCursor());
      const error = await failure(() => onClock(store.fireSchedule(fire)));

      const rolledBack = {
        schedule: (await onClock(store.listSchedules()))[0],
        cursor: await onClock(store.eventCursor()),
      };

      const fired = await onClock(store.fireSchedule({ ...fire, run: run("scheduled") }));
      const cursor = await onClock(store.eventCursor());

      const duplicate = await onClock(store.fireSchedule({ ...fire, run: run("duplicate") }));

      return {
        error,
        before,
        rolledBack,
        fired,
        duplicate,
        cursor,
        after: await onClock(store.eventCursor()),
        runs: (await onClock(store.queryRuns({ limit: 200, now: at }))).map(({ id }) => id).sort(),
        events: await onClock(store.events(before.cursor, 10)),
      };
    }

    if (path === "/waits") {
      await onClock(store.createRun(run()));
      await onClock(store.claim("run", "owner"));
      await onClock(
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
            { kind: "suspend_run", wakeAt: "2026-10-22T01:00:00.000Z" },
          ],
        }),
      );
      const wait = (await onClock(store.getWaits("run")))[0];

      if (!wait) {
        throw new Error("Wait was not persisted.");
      }

      const before = await onClock(store.eventCursor());

      const invalid = await onClock(
        store.resolveWait({
          token: wait.token,
          payload: { approved: "invalid" },
          at,
        }),
      );

      const unchanged = await onClock(store.eventCursor());

      const results = await Promise.all(
        [true, false].map((payload) =>
          onClock(store.resolveWait({ token: wait.token, payload: { approved: payload }, at })),
        ),
      );

      const events = await onClock(store.events(before.cursor, 20));

      return {
        invalid,
        before,
        unchanged,
        results,
        events,
        transactions: [...new Set(events.map((event) => event.txn))].length,
        snapshot: await onClock(store.dashboardSnapshot("run")),
      };
    }

    if (path === "/prune") {
      await onClock(store.createRun(run()));
      await onClock(store.claim("run", "owner"));
      await onClock(store.apply({ runId: "run", token: "owner", effects: logs() }));
      const events = await onClock(store.events(0, 10));
      const tail = events.at(-1);

      if (!tail) {
        throw new Error("Missing transaction tail.");
      }

      // One clock reading stamps a whole transaction, so age its first row to split it at the cutoff.
      this.ctx.storage.sql.exec(
        "UPDATE events SET at=? WHERE sequence<=3",
        "2026-10-21T00:00:00.000Z",
      );

      const removed = await onClock(
        store.pruneEvents(new Date(Date.parse(tail.at) + EVENT_RETENTION.maxAgeMs).toISOString()),
      );

      const empty = await onClock(store.events(0, 10));
      const cursor = await onClock(store.eventCursor());
      await onClock(store.heartbeat("run", "owner"));

      return {
        events,
        removed,
        empty,
        cursor,
        next: await onClock(store.events(cursor.cursor, 10)),
        oldest: await onClock(store.oldestEventSequence()),
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
