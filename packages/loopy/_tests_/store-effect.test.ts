import { expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { OwnershipError, StorageError, StoreService } from "../src/core/store";
import { MemoryStore, makeMemoryStore, memoryStoreLayer } from "../src/store/memory";
import { newRun } from "./fixture";

// This entry deliberately avoids the SQL and contract imports, so memory behavior is isolated.
test("memory operations are lazy and ownership failures remain typed", () => {
  const store = new MemoryStore();
  const create = store.createRun(newRun());
  expect(Effect.runSync(store.getRun("run"))).toBeUndefined();
  Effect.runSync(create);
  Effect.runSync(store.claim("run", "owner"));

  const rejected = Effect.runSync(
    Effect.result(store.apply({ runId: "run", token: "other", effects: [] })),
  );

  expect(rejected._tag).toBe("Failure");

  if (rejected._tag === "Failure") {
    expect(rejected.failure).toBeInstanceOf(OwnershipError);
  }
});

test("failed memory batches roll back data and outbox and retain invalid timestamp defects", () => {
  const store = Effect.runSync(makeMemoryStore());
  Effect.runSync(store.createRun(newRun()));
  Effect.runSync(store.claim("run", "owner"));
  const before = Effect.runSync(store.snapshotRun("run"));
  let deliveries = 0;
  const unsubscribe = store.subscribe(() => deliveries++);

  const rejected = Effect.runSyncExit(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        { kind: "schedule_retry", at: "2026-10-16T01:00:00.000Z" },
        { kind: "suspend_run", at: "invalid date", wakeAt: null },
      ],
    }),
  );

  expect(Exit.isFailure(rejected)).toBe(true);

  if (Exit.isFailure(rejected)) {
    expect(rejected.cause.reasons.some(Cause.isDieReason)).toBe(true);
  }

  expect(Effect.runSync(store.snapshotRun("run"))).toEqual(before);
  expect(deliveries).toBe(0);
  unsubscribe();
  const duplicate = Effect.runSync(Effect.result(store.createRun(newRun())));

  if (duplicate._tag === "Failure") {
    expect(duplicate.failure).toBeInstanceOf(StorageError);
  } else {
    throw new Error("Duplicate create succeeded");
  }
});

test("one memory layer instance shares state within a build and isolates separate builds", async () => {
  const layer = memoryStoreLayer();

  const read = Effect.gen(function* () {
    const store = yield* StoreService;

    return yield* store.getRun("run");
  });

  const writeAndRead = Effect.gen(function* () {
    const store = yield* StoreService;
    yield* store.createRun(newRun());

    return yield* read;
  });

  expect(await Effect.runPromise(writeAndRead.pipe(Effect.provide(layer)))).toEqual(newRun());
  expect(await Effect.runPromise(read.pipe(Effect.provide(layer)))).toBeUndefined();
});
