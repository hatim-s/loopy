import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "@loopy/contract";
import { Cause, Effect, Exit, Schema } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { StorageError } from "../../core/src/store";
import { makeSqliteRunStore } from "../src/store/open";

const nodeId = Schema.decodeUnknownSync(nodeIdSchema)("0:code");

const acquire = () => makeSqliteRunStore(":memory:");

test("schedule rejections are typed and schedule timestamps normalize to UTC", async () => {
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

test("invariant failures die and roll back their complete batch", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* acquire();
        yield* store.createRun(newRun());
        yield* store.claim("run", "owner");
        const before = yield* store.dashboardSnapshot("run");
        let deliveries = 0;
        store.subscribe(() => deliveries++);

        const failed = yield* Effect.exit(
          store.apply({
            runId: "run",
            token: "owner",
            effects: [
              {
                kind: "write_log",
                executionKey: { runId: "run", nodeId, scope: [] },
                attempt: 1,
                at: newRun().createdAt,
                log: { message: "rolled back", data: null },
              },
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

        expect(yield* store.dashboardSnapshot("run")).toEqual(before);
        expect(deliveries).toBe(0);

        const invalidTime = yield* Effect.exit(
          store.apply({
            runId: "run",
            token: "owner",
            effects: [
              {
                kind: "write_log",
                executionKey: { runId: "run", nodeId, scope: [] },
                attempt: 1,
                at: newRun().createdAt,
                log: { message: "rolled back", data: null },
              },
              { kind: "suspend_run", wakeAt: "invalid date" },
            ],
          }),
        );

        expect(Exit.isFailure(invalidTime)).toBe(true);

        if (Exit.isFailure(invalidTime)) {
          expect(invalidTime.cause.reasons.some(Cause.isDieReason)).toBe(true);
        }

        expect(yield* store.dashboardSnapshot("run")).toEqual(before);
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

test("a closed store reports unavailable storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-store-closed-"));

  try {
    const store = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeSqliteRunStore(join(root, "runs.sqlite"));
          yield* store.createRun(newRun());

          return store;
        }),
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
