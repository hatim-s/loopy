import { expect, test } from "bun:test";
import type { Json, RunOutcome, StepRecord } from "../src/core/index.js";
import {
  CommandExitError,
  type LoopyContext,
  MemoryRunStore,
  map,
  parallel,
  race,
  StepFailedError,
} from "../src/runtime/index.js";
import { delay, fixture } from "./engine-fixture.js";

test("engine succeeds and releases ownership", async () => {
  const f = await fixture();
  expect(
    await f.execute(async (ctx) => ctx.command("echo", { program: "echo", args: ["ok"] })),
  ).toEqual({ status: "succeeded", output: f.executor.result });
  expect(await f.store.getRun("run")).toMatchObject({
    status: "succeeded",
    output: f.executor.result,
  });
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
});

test("workflow errors fail the run", async () => {
  const f = await fixture();
  expect(
    await f.execute(async () => {
      throw new Error("Workflow broke. Fix it.");
    }),
  ).toEqual({ status: "failed", error: "Workflow broke. Fix it." });
});

test("replay memoizes completed work without re-executing it", async () => {
  const f = await fixture();
  let calls = 0;

  const workflow = async (ctx: LoopyContext) => {
    const value = await ctx.step("value", () => {
      calls++;

      return { answer: 42 };
    });

    await ctx.sleep("30s");

    return value;
  };

  await f.execute(workflow);
  await f.execute(workflow);
  f.advance(30_000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: { answer: 42 } });
  expect(calls).toBe(1);
});

test("replay detects a changed step key", async () => {
  const f = await fixture();
  await f.execute(async (ctx) => {
    await ctx.step("original", () => 1);
    await ctx.sleep("1h");

    return null;
  });
  expect(await f.execute(async (ctx) => ctx.step("changed", () => 2))).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Step 1 expected key 'original' but received 'changed'."),
  });
});

test("user code cannot catch nondeterminism and succeed", async () => {
  const f = await fixture();
  await f.execute(async (ctx) => {
    await ctx.step("original", () => 1);
    await ctx.sleep("1h");

    return null;
  });

  const result = await f.execute(async (ctx) => {
    try {
      await ctx.step("changed", () => 2);
    } catch {
      return "caught";
    }

    return "done";
  });

  expect(result).toMatchObject({
    status: "failed",
    error: expect.stringContaining("expected key 'original'"),
  });
  expect((await f.store.getRun("run"))?.status).toBe("failed");
});

test("retry suspends with nextRetryAt and resumes when due", async () => {
  const f = await fixture();
  f.executor.failure = new Error("Spawn failed. Check the executable.");
  const workflow = async (ctx: LoopyContext) => ctx.command("echo", { program: "echo", args: [] });
  expect(await f.execute(workflow)).toEqual({
    status: "suspended",
    wakeAt: "2026-10-16T00:00:01.000Z",
  });
  expect((await f.store.getSteps("run"))[0]).toMatchObject({
    status: "retrying",
    attempt: 1,
    nextRetryAt: "2026-10-16T00:00:01.000Z",
  });
  await f.execute(workflow);
  expect(f.executor.calls).toHaveLength(1);
  f.advance(1000);
  delete f.executor.failure;
  expect((await f.execute(workflow)).status).toBe("succeeded");
  expect(f.executor.calls).toHaveLength(2);
});

test("default retry exhausts three attempts with exponential backoff", async () => {
  const f = await fixture();

  const workflow = async (ctx: LoopyContext) =>
    ctx.step("broken", () => {
      throw new Error("Broken. Fix it.");
    });

  expect(await f.execute(workflow)).toEqual({
    status: "suspended",
    wakeAt: "2026-10-16T00:00:01.000Z",
  });
  f.advance(1000);
  expect(await f.execute(workflow)).toEqual({
    status: "suspended",
    wakeAt: "2026-10-16T00:00:03.000Z",
  });
  f.advance(2000);
  expect((await f.execute(workflow)).status).toBe("failed");
  expect((await f.store.getSteps("run"))[0]).toMatchObject({
    attempt: 3,
    maxAttempts: 3,
    status: "failed",
  });
});

test("nonzero exit fails without retry and retains stderr", async () => {
  const f = await fixture();
  f.executor.result = {
    stdout: "partial",
    stderr: "permission denied",
    exitCode: 1,
    durationMs: 10,
  };
  expect(
    await f.execute(async (ctx) => ctx.command("exit", { program: "false", args: [] })),
  ).toMatchObject({ status: "failed", error: expect.stringContaining("permission denied") });
  expect((await f.store.getSteps("run"))[0]).toMatchObject({ status: "failed", attempt: 1 });
  expect(new CommandExitError(f.executor.result).output).toEqual(f.executor.result);
});

test("retryOn exit retries the command and succeeds", async () => {
  const f = await fixture();
  f.executor.result.exitCode = 1;

  const workflow = async (ctx: LoopyContext) =>
    ctx.command("exit", { program: "false", args: [] }, { retry: { retryOn: "exit" } });

  expect((await f.execute(workflow)).status).toBe("suspended");
  f.advance(1000);
  f.executor.result.exitCode = 0;
  expect((await f.execute(workflow)).status).toBe("succeeded");
  expect(f.executor.calls).toHaveLength(2);
});

test("sleep suspends and resumes without an in-process timer", async () => {
  const f = await fixture();

  const workflow = async (ctx: LoopyContext) => {
    await ctx.sleep("1h");

    return "awake";
  };

  expect(await f.execute(workflow)).toEqual({
    status: "suspended",
    wakeAt: "2026-10-16T01:00:00.000Z",
  });
  expect(f.timers.size).toBe(0);
  f.advance(3_600_000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: "awake" });
  expect((await f.store.getSteps("run"))[0]?.attempt).toBe(1);
});

test("parallel replays two steps per branch in original finish order", async () => {
  const f = await fixture();
  const calls: string[] = [];

  const workflow = async (ctx: LoopyContext) => {
    const values = await parallel(
      ["A", "B"].map((branch) => async () => {
        await ctx.step(`${branch}1`, async () => {
          calls.push(`${branch}1`);
          await delay(branch === "A" ? 20 : 1);

          return branch;
        });

        return ctx.step(`${branch}2`, () => {
          calls.push(`${branch}2`);

          return branch;
        });
      }),
    );

    await ctx.sleep("1s");

    return values;
  };

  await f.execute(workflow);
  expect((await f.store.getSteps("run")).map((step) => step.key)).toEqual([
    "A1",
    "B1",
    "B2",
    "A2",
    "sleep",
  ]);
  f.advance(1000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: ["A", "B"] });
  expect(calls).toEqual(["A1", "B1", "B2", "A2"]);
});

test("map replays three multi-step callbacks with varied delays", async () => {
  const f = await fixture();
  const calls: string[] = [];

  const workflow = async (ctx: LoopyContext) => {
    const values = await map(
      [20, 1, 8],
      async (wait, index) => {
        await ctx.step(`${index}:first`, async () => {
          calls.push(`${index}:first`);
          await delay(wait);

          return index;
        });

        return ctx.step(`${index}:second`, () => {
          calls.push(`${index}:second`);

          return index * 2;
        });
      },
      { concurrency: 3 },
    );

    await ctx.sleep("1s");

    return values;
  };

  await f.execute(workflow);
  const before = [...calls];
  f.advance(1000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: [0, 2, 4] });
  expect(calls).toEqual(before);
  expect(calls).toHaveLength(6);
});

test("crash recovery re-executes a stored running step with attempt incremented", async () => {
  const f = await fixture();
  await f.store.claim("run", "crashed");
  await f.store.putStep("run", "crashed", {
    runId: "run",
    seq: 1,
    key: "recover",
    kind: "function",
    status: "running",
    input: null,
    attempt: 1,
    maxAttempts: 3,
    startedAt: f.run.createdAt,
  });
  await f.store.suspend("run", "crashed");
  await f.store.release("run", "crashed");
  let calls = 0;
  expect(
    await f.execute(async (ctx) =>
      ctx.step("recover", () => {
        calls++;

        return 42;
      }),
    ),
  ).toEqual({ status: "succeeded", output: 42 });
  expect(calls).toBe(1);
  expect((await f.store.getSteps("run"))[0]).toMatchObject({ status: "succeeded", attempt: 2 });
});

test("a caught step failure replays as the same failure", async () => {
  const f = await fixture();
  const errors: string[] = [];
  let calls = 0;

  const workflow = async (ctx: LoopyContext) => {
    try {
      await ctx.step(
        "broken",
        () => {
          calls++;
          throw new Error("Broken. Fix it.");
        },
        { retry: { attempts: 1 } },
      );
    } catch (cause) {
      expect(cause).toBeInstanceOf(StepFailedError);

      if (cause instanceof Error) {
        errors.push(cause.message);
      }
    }

    await ctx.sleep("1s");

    return "caught";
  };

  await f.execute(workflow);
  f.advance(1000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: "caught" });
  expect(calls).toBe(1);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toBe(errors[1]);
});

test("timeout names the step and limit and cancels its timer", async () => {
  const f = await fixture();
  expect(
    await f.execute(async (ctx) =>
      ctx.step(
        "slow",
        () => {
          f.advance(1000);

          return new Promise<Json>(() => {});
        },
        { timeout: "1s", retry: { attempts: 1 } },
      ),
    ),
  ).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Step 'slow' exceeded its 1000ms timeout."),
  });
  expect(f.timers.size).toBe(0);
});

test("logs are not duplicated on replay", async () => {
  const f = await fixture();

  const workflow = async (ctx: LoopyContext) => {
    ctx.log.info("started");
    ctx.log.warn("also started");
    await ctx.sleep("1s");
    ctx.log.error("resumed");

    return null;
  };

  await f.execute(workflow);
  await f.execute(workflow);
  f.advance(1000);
  await f.execute(workflow);
  expect((await f.store.getLogs("run")).map((log) => log.message)).toEqual([
    "started",
    "also started",
    "resumed",
  ]);
});

test("logs inside a skipped step do not suppress workflow logs on replay", async () => {
  const f = await fixture();

  const workflow = async (ctx: LoopyContext) => {
    await ctx.step("value", ({ log }) => {
      log.info("inside");

      return 1;
    });
    ctx.log.info("after");
    await ctx.sleep("1s");
    ctx.log.info("resumed");

    return null;
  };

  await f.execute(workflow);
  await f.execute(workflow);
  f.advance(1000);
  await f.execute(workflow);
  expect((await f.store.getLogs("run")).map((log) => [log.seq, log.message])).toEqual([
    [1, "inside"],
    [2, "after"],
    [3, "resumed"],
  ]);
});

test("non-JSON output fails without retry under the default policy", async () => {
  const f = await fixture();
  let calls = 0;
  expect(
    await f.execute(async (ctx) =>
      ctx.step("invalid", () => {
        calls++;

        return Number.NaN;
      }),
    ),
  ).toMatchObject({ status: "failed", error: expect.stringContaining("must be JSON data") });
  expect((await f.store.getSteps("run"))[0]).toMatchObject({
    status: "failed",
    attempt: 1,
    maxAttempts: 3,
  });
  expect(calls).toBe(1);
});

test("clock random and UUID are memoized across replay", async () => {
  const f = await fixture();
  const values: Json[] = [];

  const workflow = async (ctx: LoopyContext) => {
    const value = { now: await ctx.now(), random: await ctx.random(), uuid: await ctx.uuid() };
    values.push(value);
    await ctx.sleep("1s");

    return value;
  };

  await f.execute(workflow);
  f.advance(1000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: values[0] ?? null });
  expect(values[1]).toEqual(values[0]);
});

test("map bounds concurrency and preserves input order", async () => {
  let running = 0;
  let peak = 0;
  expect(
    await map(
      [3, 2, 1],
      async (item) => {
        running++;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running--;

        return item * 2;
      },
      { concurrency: 2 },
    ),
  ).toEqual([6, 4, 2]);
  expect(peak).toBe(2);
});

test("race returns the first branch result", async () => {
  expect(await race([async () => 1, async () => 2])).toBe(1);
});

class WriteFailureStore extends MemoryRunStore {
  override async putStep(runId: string, token: string, step: StepRecord): Promise<void> {
    if (step.status === "succeeded") {
      throw new Error("Step write failed. Restore storage.");
    }

    await super.putStep(runId, token, step);
  }
}

test("a failed success write does not become a retried step failure", async () => {
  const f = await fixture(new WriteFailureStore());
  expect(
    await f.execute(async (ctx) => {
      try {
        await ctx.step("value", () => 42);
      } catch {
        return "caught";
      }

      return null;
    }),
  ).toEqual({ status: "failed", error: "Step write failed. Restore storage." });
  expect((await f.store.getSteps("run"))[0]).toMatchObject({ status: "running", attempt: 1 });
});

class LogFailureStore extends MemoryRunStore {
  override async appendLog(): Promise<void> {
    throw new Error("Log write failed. Restore storage.");
  }
}

test("log flush failure fails the outcome and releases ownership", async () => {
  const f = await fixture(new LogFailureStore());
  expect(
    await f.execute(async (ctx) => {
      ctx.log.info("hello");

      return null;
    }),
  ).toEqual({ status: "failed", error: "Log write failed. Restore storage." });
  expect(await f.store.getRun("run")).toMatchObject({ status: "failed" });
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
});

class SuspendFailureStore extends MemoryRunStore {
  override async suspend(): Promise<void> {
    throw new Error("Suspend failed. Restore storage.");
  }
}

test("suspend failure persists a failed outcome and releases ownership", async () => {
  const f = await fixture(new SuspendFailureStore());
  expect(
    await f.execute(async (ctx) => {
      await ctx.sleep("1s");

      return null;
    }),
  ).toEqual({ status: "failed", error: "Suspend failed. Restore storage." });
  expect((await f.store.getRun("run"))?.status).toBe("failed");
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
});

class FinishFailureStore extends MemoryRunStore {
  override async finishRun(runId: string, token: string, outcome: RunOutcome): Promise<void> {
    if (outcome.status === "succeeded") {
      throw new Error("Finish failed. Restore storage.");
    }

    await super.finishRun(runId, token, outcome);
  }
}

test("finish failure persists a failed outcome and releases ownership", async () => {
  const f = await fixture(new FinishFailureStore());
  expect(await f.execute(async () => 42)).toEqual({
    status: "failed",
    error: "Finish failed. Restore storage.",
  });
  expect((await f.store.getRun("run"))?.status).toBe("failed");
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
});

test("retry delay is capped at sixty seconds", async () => {
  const f = await fixture();

  const workflow = async (ctx: LoopyContext) =>
    ctx.step(
      "broken",
      () => {
        throw new Error("Broken. Fix it.");
      },
      { retry: { attempts: 10 } },
    );

  let elapsed = 0;

  for (const delayMs of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
    elapsed += delayMs;
    expect(await f.execute(workflow)).toEqual({
      status: "suspended",
      wakeAt: new Date(Date.parse(f.run.createdAt) + elapsed).toISOString(),
    });
    f.advance(delayMs);
  }
});

test("sleep parses durations in days", async () => {
  const f = await fixture();
  expect(
    await f.execute(async (ctx) => {
      await ctx.sleep("2d");

      return null;
    }),
  ).toEqual({ status: "suspended", wakeAt: "2026-10-18T00:00:00.000Z" });
});

test("invalid durations name the rejected input", async () => {
  const f = await fixture();
  expect(
    await f.execute(async (ctx) => {
      await ctx.sleep(-1);

      return null;
    }),
  ).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Duration '-1' is invalid."),
  });
});

test("command exit policy accepts only declared success codes before parsing", async () => {
  for (const [exitCode, okExitCodes, expected] of [
    [1, [0, 1], "succeeded"],
    [1, undefined, "failed"],
    [2, [0, 1], "failed"],
  ] as const) {
    const f = await fixture();
    f.executor.result = { ...f.executor.result, exitCode };

    const outcome = await f.execute((ctx) =>
      ctx.command("lookup", { program: "which", args: ["missing"] }, { okExitCodes }, (output) =>
        output.exitCode === 1 ? null : output.stdout,
      ),
    );

    expect(outcome.status).toBe(expected);

    if (expected === "succeeded") {
      expect((await f.store.getSteps("run"))[0]).toMatchObject({
        status: "succeeded",
        output: null,
      });
    }
  }
});
