import { expect, test } from "bun:test";
import { MemoryRunStore } from "../src/runtime/index.js";
import { fixture } from "./fixture.js";

test("activation renews ownership every 15 seconds while a step is running", async () => {
  const renewed = Promise.withResolvers<void>();
  let heartbeats = 0;

  class RecordingStore extends MemoryRunStore {
    override async heartbeat(runId: string, token: string) {
      const owned = await super.heartbeat(runId, token);
      heartbeats++;
      renewed.resolve();

      return owned;
    }
  }

  const f = await fixture(new RecordingStore());

  const activation = f.execute(async (context) =>
    context.step("wait", async () => {
      await renewed.promise;

      return 42;
    }),
  );

  expect(await activation).toEqual({ status: "succeeded", output: 42 });
  expect(heartbeats).toBe(1);
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
}, 20_000);
