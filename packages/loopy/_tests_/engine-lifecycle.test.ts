import { expect, spyOn, test } from "bun:test";
import type { EngineLog, EngineStep } from "../src/core/index.js";
import { MemoryRunStore, race } from "../src/runtime/index.js";
import { delay, fixture } from "./engine-fixture.js";

class ReadFailureStore extends MemoryRunStore {
  constructor(private readonly operation: "steps" | "logs") {
    super();
  }
  override async getSteps(runId: string): Promise<EngineStep[]> {
    if (this.operation === "steps") {
      throw new Error("Steps unavailable. Restore storage.");
    }

    return super.getSteps(runId);
  }
  override async getLogs(): Promise<EngineLog[]> {
    throw new Error("Logs unavailable. Restore storage.");
  }
}

for (const operation of ["steps", "logs"] as const) {
  test(`${operation} read failure releases the run into a claimable suspension`, async () => {
    const f = await fixture(new ReadFailureStore(operation));
    await expect(f.execute(async () => null)).rejects.toThrow("unavailable. Restore storage.");
    const run = await f.store.getRun("run");
    expect(run?.status).toBe("suspended");
    expect(run?.owner).toBeUndefined();
    expect(run?.wakeAt).toBe(run?.updatedAt);
    expect((await f.store.claim("run", "next")).status).toBe("running");
  });
}

class FinishFailureStore extends MemoryRunStore {
  override async finishRun(): Promise<void> {
    throw new Error("Finish unavailable. Restore storage.");
  }
}

test("two finish failures still release a running run into a due suspension", async () => {
  const f = await fixture(new FinishFailureStore());
  await expect(f.execute(async () => null)).rejects.toThrow("Finish unavailable.");
  expect(await f.store.getRun("run")).toMatchObject({ status: "suspended" });
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
  expect((await f.store.dueRuns(new Date().toISOString())).map((run) => run.id)).toEqual(["run"]);
});

class ReleaseFailureStore extends ReadFailureStore {
  override async release(runId: string, token: string): Promise<void> {
    await super.release(runId, token);
    throw new Error("Release unavailable. Restore storage.");
  }
}

test("release failure is attached as the cause of the earlier read error", async () => {
  const f = await fixture(new ReleaseFailureStore("steps"));
  await expect(f.execute(async () => null)).rejects.toMatchObject({
    message: "Steps unavailable. Restore storage.",
    cause: new Error("Release unavailable. Restore storage."),
  });
});

test("race closes new steps and drains the losing step before releasing ownership", async () => {
  const f = await fixture();
  let drained = false;
  const errors: string[] = [];

  const result = await f.execute(async (ctx) =>
    race([
      async () => ctx.step("winner", () => "won"),
      async () => {
        await ctx.step("loser", async () => {
          await delay(20);

          return "lost";
        });
        drained = true;

        try {
          await ctx.step("too late", () => "invalid");
        } catch (cause) {
          if (cause instanceof Error) {
            errors.push(cause.message);
          }
        }

        return "lost";
      },
    ]),
  );

  expect(result).toEqual({ status: "succeeded", output: "won" });
  expect(drained).toBe(true);
  expect(errors).toEqual([
    "Activation is closed. Await all branches before returning from the workflow.",
  ]);
  expect((await f.store.getSteps("run")).map((step) => step.key)).toEqual(["winner", "loser"]);
});

test("a long live step waits for changes without polling macrotasks", async () => {
  const f = await fixture();
  const timer = spyOn(globalThis, "setTimeout");

  try {
    expect(
      await f.execute(async (ctx) =>
        ctx.step("slow", async () => {
          await delay(50);

          return "done";
        }),
      ),
    ).toEqual({ status: "succeeded", output: "done" });
    expect(timer.mock.calls.length).toBeLessThan(10);
  } finally {
    timer.mockRestore();
  }
});

class TerminalReleaseFailureStore extends MemoryRunStore {
  override async release(runId: string, token: string): Promise<void> {
    await super.release(runId, token);
    throw new Error("Release unavailable. Restore storage.");
  }
}

test("release failure preserves a failed workflow outcome as the primary error", async () => {
  const f = await fixture(new TerminalReleaseFailureStore());
  await expect(
    f.execute(async () => {
      throw new Error("Workflow failed. Fix the workflow.");
    }),
  ).rejects.toMatchObject({
    message: "Workflow failed. Fix the workflow.",
    cause: new Error("Release unavailable. Restore storage."),
  });
});
