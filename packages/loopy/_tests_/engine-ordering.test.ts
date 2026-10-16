import { expect, test } from "bun:test";
import type { EngineStep } from "../src/core/index.js";
import { type LoopyContext, MemoryRunStore, parallel } from "../src/runtime/index.js";
import { delay, fixture } from "./engine-fixture.js";

for (const wait of ["sleep", "retry"] as const) {
  test(`live ${wait} completion waits for queued memoized branch results`, async () => {
    const f = await fixture();

    const workflow = (ctx: LoopyContext) =>
      parallel([
        async () => {
          await ctx.step("a1", async () => {
            await delay(5);

            return null;
          });

          return ctx.step("a2", () => "a");
        },
        async () => {
          if (wait === "sleep") {
            await ctx.sleep("1s");
          } else {
            await ctx.step("retry", ({ attempt }) => {
              if (attempt === 1) {
                throw new Error("Try again. Retry the step.");
              }

              return null;
            });
          }

          return ctx.step("b2", () => "b");
        },
      ]);

    expect((await f.execute(workflow)).status).toBe("suspended");
    expect((await f.store.getSteps("run")).map((step) => step.key)).toEqual([
      "a1",
      wait === "sleep" ? "sleep" : "retry",
      "a2",
    ]);
    f.advance(1000);
    expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: ["a", "b"] });
  });
}

class DelayedStore extends MemoryRunStore {
  override async putStep(runId: string, token: string, step: EngineStep): Promise<void> {
    if (step.status === "succeeded" && step.key === "a1") {
      await delay(20);
    }

    await super.putStep(runId, token, step);
  }
}

test("terminal write latency preserves the finish order observed by workflow code", async () => {
  const f = await fixture(new DelayedStore());
  const observed: string[] = [];

  const workflow = async (ctx: LoopyContext) => {
    await parallel(
      ["a", "b"].map((key) => async () => {
        await ctx.step(`${key}1`, () => key);
        observed.push(key);
        await ctx.step(`${key}2`, () => key);
      }),
    );
    await ctx.sleep("1s");

    return [...observed];
  };

  expect((await f.execute(workflow)).status).toBe("suspended");
  const original = [...observed];

  const terminal = (await f.store.getSteps("run"))
    .filter((step) => step.status === "succeeded")
    .sort((a, b) => a.finishOrder - b.finishOrder);

  expect(terminal.filter((step) => step.key.endsWith("1")).map((step) => step.output)).toEqual(
    original,
  );
  observed.length = 0;
  f.advance(1000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: original });
});
