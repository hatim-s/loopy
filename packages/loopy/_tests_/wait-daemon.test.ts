import { expect, test } from "bun:test";
import { Daemon } from "../src/host/index.js";
import { loopy, wait } from "../src/sdk/graph/index.js";
import { MemoryStore } from "../src/store/index.js";
import { FakeExecutor, newRun } from "./fixture.js";

test("daemon leaves an indefinite sleep when a durable approval signal wakes its run", async () => {
  const store = new MemoryStore();

  const graph = loopy("prompt", {
    input: {},
    run: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
  }).graph;

  await store.createRun({ ...newRun(), input: {} });
  const errors: Error[] = [];
  let sleeping: (() => void) | undefined;

  const asleep = new Promise<void>((resolve) => {
    sleeping = resolve;
  });

  const finished = new Promise<void>((resolve) => {
    store.subscribe((events) => {
      if (events.some((event) => event.entity === "run" && event.kind === "finished")) {
        resolve();
      }
    });
  });

  const daemon = new Daemon({
    store,
    concurrency: 1,
    revisionFor: () => "bundle",
    prepare: async () => ({ graph, executor: new FakeExecutor() }),
    onError: (error) => errors.push(error),
    sleep: async (...args) => {
      const [, signal] = args;
      sleeping?.();

      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
  });

  await daemon.tick();
  const running = daemon.run();

  try {
    await asleep;
    const hook = (await store.getWaits("run"))[0];

    if (!hook) {
      throw new Error("Missing wait.");
    }

    expect((await store.getRun("run"))?.status).toBe("suspended");
    await store.resolveWait({ token: hook.token, payload: true, at: new Date().toISOString() });
    await Promise.race([
      finished,
      Bun.sleep(500).then(() => {
        throw new Error("Daemon did not wake after signal.");
      }),
    ]);
    expect(await store.getRun("run")).toMatchObject({ status: "succeeded", output: true });
    expect(errors).toEqual([]);
  } finally {
    await daemon.stop();
    await running;
  }
});
