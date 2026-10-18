import { expect, test } from "bun:test";
import { withHeartbeat } from "../src/host/heartbeat.js";
import { SqliteRunStore } from "../src/store/index.js";
import { FakeClock, newRun } from "./fixture.js";

test("heartbeat rejects a held activation when another token takes ownership", async () => {
  const clock = new FakeClock();
  const store = new SqliteRunStore(":memory:", clock.now, { leaseMs: 2000 });
  const held = Promise.withResolvers<void>();

  try {
    await store.createRun(newRun());
    await store.claim("run", "owner");
    const active = withHeartbeat(store, "run", "owner", () => held.promise, clock);
    clock.advance(499);
    await store.release("run", "owner");
    await store.claim("run", "other");
    clock.advance(1);
    await expect(
      Promise.race([
        active,
        Bun.sleep(100).then(() => {
          throw new Error("Ownership loss was not reported.");
        }),
      ]),
    ).rejects.toMatchObject({ code: "owned_elsewhere" });
    expect((await store.getRun("run"))?.owner?.token).toBe("other");
  } finally {
    held.resolve();
    store.close();
  }
});
