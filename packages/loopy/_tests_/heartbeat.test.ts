import { expect, test } from "bun:test";
import { withHeartbeat } from "../src/host/heartbeat.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";

test("activation renews ownership at a quarter of its lease while a step is running", async () => {
  const renewed = Promise.withResolvers<void>();
  let heartbeats = 0;

  class RecordingStore extends MemoryStore {
    override async heartbeat(runId: string, token: string) {
      const owned = await super.heartbeat(runId, token);
      heartbeats++;
      renewed.resolve();

      return owned;
    }
  }

  const store = new RecordingStore(undefined, 2000);
  await store.createRun(newRun());
  await store.claim("run", "owner");
  expect(
    await withHeartbeat(store, "run", "owner", async () => {
      await renewed.promise;

      return 42;
    }),
  ).toBe(42);
  await store.release("run", "owner");
  expect(heartbeats).toBe(1);
  expect((await store.getRun("run"))?.owner).toBeUndefined();
}, 2_000);
