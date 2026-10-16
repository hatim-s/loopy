import { expect, test } from "bun:test";
import type { Command, CommandResult, EngineRun, Json } from "../src/core/index.js";
import {
  activate,
  backoffMs,
  type Context,
  durationMs,
  type EngineClock,
  type Executor,
  MemoryRunStore,
  map,
  OwnershipError,
  parallel,
  race,
} from "../src/runtime/index.js";

class FakeExecutor implements Executor {
  calls: Command[] = [];
  result: CommandResult = { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
  failure?: Error;
  async execute(command: Command): Promise<CommandResult> {
    this.calls.push(command);

    if (this.failure) {
      throw this.failure;
    }

    return this.result;
  }
}

async function fixture() {
  let time = Date.parse("2026-10-16T00:00:00.000Z");
  const timers = new Map<() => void, number>();

  const clock: EngineClock = {
    now: () => time,
    tick: async () => {
      for (let index = 0; index < 30; index++) {
        await Promise.resolve();
      }
    },
    timeout: (callback, milliseconds) => {
      timers.set(callback, time + milliseconds);

      return () => {
        timers.delete(callback);
      };
    },
  };

  function advance(milliseconds: number): void {
    time += milliseconds;

    for (const [callback, deadline] of timers) {
      if (deadline <= time) {
        timers.delete(callback);
        callback();
      }
    }
  }

  const run: EngineRun = {
    id: "run",
    slug: "test",
    bundleHash: "bundle",
    input: null,
    status: "queued",
    createdAt: new Date(time).toISOString(),
    updatedAt: new Date(time).toISOString(),
  };

  const store = new MemoryRunStore(clock.now);
  const executor = new FakeExecutor();
  await store.createRun(run);

  function execute(workflow: (context: Context) => Promise<Json>) {
    return activate({ run, store, executor, workflow, cwd: "/workspace", mode: "sandbox", clock });
  }

  return { run, store, executor, execute, advance, timers, clock };
}

test("engine succeeds with memoized command output", async () => {
  const f = await fixture();

  const result = await f.execute(async (ctx) =>
    ctx.command("echo", { program: "echo", args: ["ok"] }),
  );

  expect(result.status).toBe("succeeded");
  expect(result.output).toEqual(f.executor.result);
  expect(result.ownerToken).toBeUndefined();
  expect((await f.store.getSteps("run"))[0]).toMatchObject({
    seq: 1,
    attempt: 1,
    status: "succeeded",
  });
});

test("engine fails when workflow throws", async () => {
  const f = await fixture();

  const result = await f.execute(async () => {
    throw new Error("Workflow broke. Fix it.");
  });

  expect(result).toMatchObject({ status: "failed", error: "Workflow broke. Fix it." });
});

test("replay memoizes completed work and logs across sleep", async () => {
  const f = await fixture();
  let calls = 0;

  const workflow = async (ctx: Context) => {
    ctx.log.info("started", { value: 1 });

    const value = await ctx.step("value", () => {
      calls++;

      return { answer: 42 };
    });

    await ctx.command("echo", { program: "echo", args: [] });
    await ctx.sleep("30s");
    ctx.log.warn("finished");

    return value;
  };

  expect((await f.execute(workflow)).status).toBe("suspended");
  expect((await f.execute(workflow)).status).toBe("suspended");
  f.advance(30_000);
  expect(await f.execute(workflow)).toMatchObject({ status: "succeeded", output: { answer: 42 } });
  expect(calls).toBe(1);
  expect(f.executor.calls).toHaveLength(1);
  expect(await f.store.getLogs("run")).toMatchObject([
    { seq: 1, message: "started" },
    { seq: 2, message: "finished" },
  ]);
});

test("replay fails on a different key at the same sequence", async () => {
  const f = await fixture();
  await f.execute(async (ctx) => {
    await ctx.step("original", () => 1);
    await ctx.sleep("1h");

    return null;
  });
  const result = await f.execute(async (ctx) => ctx.step("changed", () => 2));
  expect(result.status).toBe("failed");
  expect(result.error).toContain("Step 1 expected key 'original' but received 'changed'.");
});

test("retry persists backoff, stays blocked until due, then succeeds", async () => {
  const f = await fixture();
  f.executor.failure = new Error("Spawn failed. Check the executable.");
  const workflow = async (ctx: Context) => ctx.command("echo", { program: "echo", args: [] });
  const first = await f.execute(workflow);
  expect(first).toMatchObject({ status: "suspended", wakeAt: "2026-10-16T00:00:01.000Z" });
  expect((await f.store.getSteps("run"))[0]).toMatchObject({
    attempt: 1,
    maxAttempts: 3,
    status: "retrying",
    nextRetryAt: first.wakeAt,
  });
  await f.execute(workflow);
  expect(f.executor.calls).toHaveLength(1);
  f.advance(1000);
  f.executor.failure = undefined;
  expect((await f.execute(workflow)).status).toBe("succeeded");
  expect(f.executor.calls).toHaveLength(2);
  expect((await f.store.getSteps("run"))[0]?.error).toBeUndefined();
});

test("nonzero exit fails without retries unless exit retry is selected", async () => {
  const f = await fixture();
  f.executor.result.exitCode = 1;
  expect(
    (await f.execute(async (ctx) => ctx.command("exit", { program: "false", args: [] }))).status,
  ).toBe("failed");
  const g = await fixture();
  g.executor.result.exitCode = 1;
  expect(
    (
      await g.execute(async (ctx) =>
        ctx.command("exit", { program: "false", args: [] }, { retry: { retryOn: "exit" } }),
      )
    ).status,
  ).toBe("suspended");
});

test("parallel keeps step sequence stable and chooses the earliest wake", async () => {
  const f = await fixture();

  const workflow = async (ctx: Context) => {
    await parallel([() => ctx.step("first", () => 1), () => ctx.step("second", () => 2)]);
    await parallel([() => ctx.sleep("1h"), () => ctx.sleep("10m")]);

    return null;
  };

  const first = await f.execute(workflow);
  expect(first.wakeAt).toBe("2026-10-16T00:10:00.000Z");
  f.advance(600_000);
  expect((await f.execute(workflow)).wakeAt).toBe("2026-10-16T01:00:00.000Z");
  f.advance(3_000_000);
  expect((await f.execute(workflow)).status).toBe("succeeded");
  expect((await f.store.getSteps("run")).map((step) => [step.seq, step.key])).toEqual([
    [1, "first"],
    [2, "second"],
    [3, "sleep"],
    [4, "sleep"],
  ]);
});

test("timeout fails the attempt using an injected clock", async () => {
  const f = await fixture();

  const result = await f.execute(async (ctx) =>
    ctx.step(
      "slow",
      () => {
        f.advance(1000);

        return new Promise<Json>(() => {});
      },
      { timeout: "1s", retry: { attempts: 1 } },
    ),
  );

  expect(result.status).toBe("failed");
  expect(result.error).toContain("Step timed out.");
  expect((await f.store.getSteps("run"))[0]).toMatchObject({ status: "failed", attempt: 1 });
  expect(f.timers.size).toBe(0);
});

test("ownership fences every stale writer and isolates returned records", async () => {
  const f = await fixture();
  const claimed = await f.store.claim("run", "old");
  claimed.status = "failed";
  expect((await f.store.getRun("run"))?.status).toBe("running");
  await f.store.suspend("run", "old");
  await f.store.release("run", "old");
  await f.store.claim("run", "new");

  const step = {
    runId: "run",
    seq: 1,
    key: "test",
    kind: "function",
    status: "running",
    input: null,
    attempt: 1,
    maxAttempts: 3,
    startedAt: claimed.createdAt,
  } satisfies Parameters<MemoryRunStore["putStep"]>[2];

  const writes = [
    () => f.store.claim("run", "old"),
    () => f.store.heartbeat("run", "old"),
    () => f.store.suspend("run", "old"),
    () => f.store.finishRun("run", "old", "failed"),
    () => f.store.release("run", "old"),
    () => f.store.putStep("run", "old", step),
    () =>
      f.store.appendLog("run", "old", {
        runId: "run",
        seq: 1,
        level: "info",
        message: "stale",
        at: claimed.createdAt,
      }),
  ];

  for (const write of writes) {
    await expect(write()).rejects.toBeInstanceOf(OwnershipError);
  }
});

test("bounded map preserves results and race returns the first result", async () => {
  let running = 0;
  let peak = 0;

  const results = await map(
    [3, 2, 1],
    async (item) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running--;

      return item * 2;
    },
    { concurrency: 2 },
  );

  expect(results).toEqual([6, 4, 2]);
  expect(peak).toBe(2);
  expect(await race([async () => 1, async () => 2])).toBe(1);
  expect(durationMs("2d")).toBe(172_800_000);
  expect(backoffMs(20)).toBe(60_000);
});

test("default retry policy exhausts three attempts with exponential backoff", async () => {
  const f = await fixture();

  const workflow = async (ctx: Context) =>
    ctx.step("broken", () => {
      throw new Error("Broken. Fix it.");
    });

  expect((await f.execute(workflow)).wakeAt).toBe("2026-10-16T00:00:01.000Z");
  f.advance(1000);
  expect((await f.execute(workflow)).wakeAt).toBe("2026-10-16T00:00:03.000Z");
  f.advance(2000);
  expect((await f.execute(workflow)).status).toBe("failed");
  expect((await f.store.getSteps("run"))[0]).toMatchObject({
    attempt: 3,
    maxAttempts: 3,
    status: "failed",
  });
});

test("clock, random, and UUID values are recorded and replayed", async () => {
  const f = await fixture();

  const workflow = async (ctx: Context) => {
    const values = { now: await ctx.now(), random: await ctx.random(), uuid: await ctx.uuid() };
    await ctx.sleep("1s");

    return values;
  };

  await f.execute(workflow);
  const before = (await f.store.getSteps("run")).slice(0, 3);
  f.advance(1000);
  const result = await f.execute(workflow);
  expect(result.output).toEqual({
    now: before[0]?.output ?? null,
    random: before[1]?.output ?? null,
    uuid: before[2]?.output ?? null,
  });
  expect((await f.store.getSteps("run")).slice(0, 3)).toEqual(before);
});

test("non-JSON step output cannot be persisted as a successful step", async () => {
  const f = await fixture();

  const result = await f.execute(async (ctx) =>
    ctx.step("invalid", () => Number.NaN, { retry: { attempts: 1 } }),
  );

  expect(result.status).toBe("failed");
  expect((await f.store.getSteps("run"))[0]).toMatchObject({ status: "failed" });
});

test("due runs include queued and timed suspensions but exclude indefinite waits", async () => {
  const f = await fixture();
  expect(await f.store.dueRuns(f.run.createdAt)).toHaveLength(1);
  await f.store.claim("run", "owner");
  expect(await f.store.dueRuns(f.run.createdAt)).toEqual([]);
  await f.store.suspend("run", "owner");
  await f.store.release("run", "owner");
  expect(await f.store.dueRuns(f.run.createdAt)).toEqual([]);
  await f.store.claim("run", "owner");
  await f.store.suspend("run", "owner", f.run.createdAt);
  await f.store.release("run", "owner");
  expect(await f.store.dueRuns(f.run.createdAt)).toHaveLength(1);
});
