import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "@loopy/contract";
import { Cause, Effect, Exit, Schema } from "effect";
import { StorageError, StoreService } from "../../core/src/store";
import { makeMemoryStore } from "../../runtime/src/store/memory";
import { makeSqliteRunStore, sqliteStoreLayer } from "../../runtime/src/store/sqlite/store";
import { subscribeStore } from "../../runtime/src/store/subscription";
import { newRun } from "./fixture";

const nodeId = Schema.decodeUnknownSync(nodeIdSchema)("0:code");

for (const [name, acquire] of [
  ["memory", () => makeMemoryStore()],
  ["sqlite", () => makeSqliteRunStore(":memory:")],
] as const) {
  test(`${name} schedule rejections and timestamp normalization match`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* acquire();

          const missing = yield* Effect.result(
            store.setScheduleEnabled({ workspace: "", slug: "absent", enabled: true }),
          );

          expect(missing._tag).toBe("Failure");

          if (missing._tag === "Failure") {
            expect(missing.failure.reason).toBe("rejected");
          }

          yield* store.putSchedule({
            workspace: "",
            slug: "schedule",
            cron: "* * * * *",
            tz: "UTC",
            enabled: true,
            input: null,
            nextFireAt: "2026-10-16T00:00:00.000Z",
          });

          const schedule = yield* store.setScheduleEnabled({
            workspace: "",
            slug: "schedule",
            enabled: true,
            nextFireAt: "2026-10-16T06:30:00+05:30",
          });

          expect(schedule.nextFireAt).toBe("2026-10-16T01:00:00.000Z");
          const cursor = yield* store.eventCursor();

          const invalid = yield* Effect.exit(
            store.setScheduleEnabled({
              workspace: "",
              slug: "schedule",
              enabled: false,
              nextFireAt: "invalid",
            }),
          );

          expect(Exit.isFailure(invalid)).toBe(true);

          if (Exit.isFailure(invalid)) {
            expect(invalid.cause.reasons.some(Cause.isDieReason)).toBe(true);
          }

          expect(yield* store.listSchedules()).toEqual([schedule]);
          expect(yield* store.eventCursor()).toEqual(cursor);
        }),
      ),
    );
  });

  test(`${name} invariant failures die and roll back their complete batch`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* acquire();
          yield* store.createRun(newRun());
          yield* store.claim("run", "owner");
          const before = yield* store.snapshotRun("run");
          let deliveries = 0;
          yield* subscribeStore(store, () => deliveries++);

          const failed = yield* Effect.exit(
            store.apply({
              runId: "run",
              token: "owner",
              effects: [
                { kind: "schedule_retry", at: "2026-10-16T01:00:00.000Z" },
                {
                  kind: "write_log",
                  executionKey: { runId: "other", nodeId, scope: [] },
                  attempt: 1,
                  at: newRun().createdAt,
                  log: { message: "invalid", data: null },
                },
              ],
            }),
          );

          expect(Exit.isFailure(failed)).toBe(true);

          if (Exit.isFailure(failed)) {
            expect(failed.cause.reasons.some(Cause.isDieReason)).toBe(true);
            expect(failed.cause.reasons.some(Cause.isFailReason)).toBe(false);
          }

          expect(yield* store.snapshotRun("run")).toEqual(before);
          expect(deliveries).toBe(0);

          const invalidTime = yield* Effect.exit(
            store.apply({
              runId: "run",
              token: "owner",
              effects: [
                { kind: "schedule_retry", at: "2026-10-16T01:00:00.000Z" },
                { kind: "suspend_run", at: "invalid date", wakeAt: null },
              ],
            }),
          );

          expect(Exit.isFailure(invalidTime)).toBe(true);

          if (Exit.isFailure(invalidTime)) {
            expect(invalidTime.cause.reasons.some(Cause.isDieReason)).toBe(true);
          }

          expect(yield* store.snapshotRun("run")).toEqual(before);
          expect(deliveries).toBe(0);
          const duplicate = yield* Effect.result(store.createRun(newRun()));
          expect(duplicate._tag).toBe("Failure");

          if (duplicate._tag === "Failure") {
            expect(duplicate.failure.reason).toBe("rejected");
          }
        }),
      ),
    );
  });
}

test("subscription scope removes its listener while the store remains live", async () => {
  const store = Effect.runSync(makeMemoryStore());
  let deliveries = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* subscribeStore(store, () => deliveries++);
        yield* store.createRun(newRun());
      }),
    ),
  );
  expect(deliveries).toBe(1);
  await Effect.runPromise(store.claim("run", "owner"));
  expect(deliveries).toBe(1);
});

test("SQLite layer supplies event replay from its connection and closes it with the scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-store-layer-"));

  try {
    const store = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* StoreService;
          yield* store.createRun(newRun());
          const events = yield* store.events(0, 10);
          const txn = events[0]?.txn;

          if (!txn) {
            throw new Error("Expected committed event transaction.");
          }

          expect(yield* store.transactionEvents(txn, 0)).toEqual(events);
          expect(store.dataVersion).toBeDefined();

          if (store.dataVersion) {
            expect(yield* store.dataVersion()).toBeNumber();
          }

          return store;
        }).pipe(Effect.provide(sqliteStoreLayer(join(root, "runs.sqlite")))),
      ),
    );

    const closed = await Effect.runPromise(Effect.result(store.getRun("run")));
    expect(closed._tag).toBe("Failure");

    if (closed._tag === "Failure") {
      expect(closed.failure).toBeInstanceOf(StorageError);
      expect(closed.failure.reason).toBe("unavailable");
      expect(closed.failure.cause).toBeInstanceOf(RangeError);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
