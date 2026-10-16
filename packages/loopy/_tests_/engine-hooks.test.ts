import { describe, expect, test } from "bun:test";
import type { Json } from "../src/core/index.js";
import { SqliteRunStore } from "../src/local/index.js";
import {
  activate,
  MemoryRunStore,
  map,
  parallel,
  type RunStore,
  type WorkflowContext,
} from "../src/runtime/index.js";
import { delay, FakeExecutor, newRun } from "./fixture.js";

const stores = [
  { name: "MemoryRunStore", make: (now: () => number) => new MemoryRunStore(now) },
  { name: "SqliteRunStore", make: (now: () => number) => new SqliteRunStore(":memory:", now) },
];

async function fixture(make: (now: () => number) => RunStore) {
  let time = Date.parse(newRun().createdAt);
  const store = make(() => time);
  await store.createRun(newRun());
  const clock = { now: () => time, timeout: () => () => {} };

  const execute = (workflow: (ctx: WorkflowContext) => Promise<Json>) =>
    activate({
      store,
      workflow,
      clock,
      runId: "run",
      executor: new FakeExecutor(),
      cwd: "/workspace",
      mode: "sandbox",
    });

  return {
    store,
    execute,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

for (const { name, make } of stores) {
  describe(name, () => {
    delayedReads(make);
    resolvedBeforeExpiry(make);
    expiry(make);
    expiryRace(make);
    timeoutMessage(make);
    polling(make);
    wakeups(make);
  });
}

function delayedReadWorkflow(called: string[], signal: () => void) {
  return async (ctx: WorkflowContext) => {
    const result = await parallel([
      async () => {
        await ctx.hook("a");

        return ctx.step("x", () => {
          called.push("x");

          return "x";
        });
      },
      async () => {
        await ctx.step("y", async () => {
          signal();
          await delay(20);

          return "y";
        });

        return ctx.step("z", () => {
          called.push("z");

          return "z";
        });
      },
    ]);

    await ctx.sleep("1s");

    return result;
  };
}

async function delayedReadRun(make: (now: () => number) => RunStore) {
  const f = await fixture(make);
  const getSteps = f.store.getSteps.bind(f.store);
  f.store.getSteps = async (runId) => {
    const steps = await getSteps(runId);
    await delay(30);

    return steps;
  };

  const called: string[] = [];
  let signal = () => {};

  const running = new Promise<void>((resolve) => {
    signal = resolve;
  });

  const workflow = delayedReadWorkflow(called, signal);
  const pending = f.execute(workflow);
  await running;
  await delay(5);
  const [hook] = await f.store.listHooks("run");
  expect(await f.store.resolveHook(hook?.token ?? "", null)).toBe(true);

  return { ...f, pending, workflow, called };
}

function delayedReads(make: (now: () => number) => RunStore): void {
  test("hook resolution with 30 ms delayed getSteps preserves live call order on replay", async () => {
    const f = await delayedReadRun(make);
    expect((await f.pending).status).toBe("suspended");
    let outcome;

    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(1000);
      outcome = await f.execute(f.workflow);

      if (outcome.status !== "suspended") {
        break;
      }
    }

    expect(outcome).toEqual({ status: "succeeded", output: ["x", "z"] });
    expect(f.called).toEqual(["z", "x"]);
  });
}

function resolvedBeforeExpiry(make: (now: () => number) => RunStore): void {
  test("a payload resolved before the hook visit wins after its stored deadline", async () => {
    const f = await fixture(make);
    const workflow = (ctx: WorkflowContext) => ctx.hook("a", { timeout: "1s" });
    await f.execute(workflow);
    f.advance(999);
    const [hook] = await f.store.listHooks("run");
    expect(await f.store.resolveHook(hook?.token ?? "", 42)).toBe(true);
    f.advance(2);
    expect(await f.execute((ctx) => ctx.hook("a"))).toEqual({ status: "succeeded", output: 42 });
  });
}

function expiry(make: (now: () => number) => RunStore): void {
  test("expiry checks resolution transactionally and fences late signals", async () => {
    const f = await fixture(make);
    await f.execute((ctx) => ctx.hook("a", { timeout: "1s" }));
    await f.store.claim("run", "owner");
    const [hook] = await f.store.listHooks("run");
    expect(await f.store.resolveHook(hook?.token ?? "", 42)).toBe(true);
    f.advance(1001);
    expect(await f.store.expireHook("run", "owner", 1)).toBeUndefined();
    expect((await f.store.listPendingHooks("run", [1]))[0]?.payload).toBe(42);
    await f.store.createHook("run", "owner", {
      runId: "run",
      seq: 2,
      key: "hook:b",
      kind: "hook",
      status: "waiting",
      input: { name: "b", token: "b" },
      attempt: 1,
      maxAttempts: 1,
      startedAt: newRun().createdAt,
      wakeAt: newRun().createdAt,
    });
    await expect(f.store.expireHook("run", "stale", 2)).rejects.toThrow("not owned by this token");
    expect(await f.store.expireHook("run", "owner", 2)).toBe(newRun().createdAt);
    f.advance(-1002);
    expect(await f.store.resolveHook("b", 7)).toBe(false);
  });
}

function expiryRace(make: (now: () => number) => RunStore): void {
  test("a resolution racing the expiry transaction is delivered by the owner", async () => {
    const f = await fixture(make);
    await f.execute((ctx) => ctx.hook("a", { timeout: "1s" }));
    const [hook] = await f.store.listHooks("run");
    const expire = f.store.expireHook.bind(f.store);
    f.advance(1001);
    f.store.expireHook = async (...args) => {
      f.advance(-2);
      expect(await f.store.resolveHook(hook?.token ?? "", 42)).toBe(true);
      f.advance(2);

      return expire(...args);
    };

    expect(await f.execute((ctx) => ctx.hook("a"))).toEqual({ status: "succeeded", output: 42 });
    expect((await f.store.getSteps("run"))[0]).toMatchObject({
      status: "succeeded",
      output: 42,
      finishOrder: 1,
    });
  });
}

function timeoutMessage(make: (now: () => number) => RunStore): void {
  test("hook timeout errors use the stored deadline when replay omits timeout", async () => {
    const f = await fixture(make);
    await f.execute((ctx) => ctx.hook("a", { timeout: "1s" }));
    f.advance(1001);
    expect(await f.execute((ctx) => ctx.hook("a"))).toEqual({
      status: "failed",
      error:
        "Step 'hook:a' failed: Hook 'a' timed out at 2026-10-16T00:00:01.000Z. Resolve the hook before its deadline in a new run.",
    });
  });
}

function polling(make: (now: () => number) => RunStore): void {
  test("a waiting hook polls a handful of hook rows alongside 200 mapped steps", async () => {
    const f = await fixture(make);
    let queries = 0;
    let stepReads = 0;
    const list = f.store.listPendingHooks.bind(f.store);
    const getSteps = f.store.getSteps.bind(f.store);
    f.store.listPendingHooks = async (runId, seqs) => {
      queries++;
      expect(seqs).toEqual([1]);

      return list(runId, seqs);
    };

    f.store.getSteps = async (runId) => {
      stepReads++;

      return getSteps(runId);
    };

    const outcome = await f.execute((ctx) =>
      parallel([
        () => ctx.hook("a"),
        () =>
          map([...Array.from({ length: 200 }).keys()], (i) => ctx.step(`step-${i}`, () => i), {
            concurrency: 1,
          }),
      ]),
    );

    expect(outcome.status).toBe("suspended");
    expect(queries).toBeLessThanOrEqual(6);
    expect(stepReads).toBe(1);
  });
}

function wakeups(make: (now: () => number) => RunStore): void {
  test("a consumed hook does not leave a stale wake time on the next suspension", async () => {
    const f = await fixture(make);

    const pending = f.execute((ctx) =>
      parallel([
        async () => {
          await ctx.hook("a");
          await ctx.sleep("1h");

          return null;
        },
        () =>
          ctx.step("busy", async () => {
            await delay(150);

            return null;
          }),
      ]),
    );

    await delay(10);
    const [hook] = await f.store.listHooks("run");
    expect(await f.store.resolveHook(hook?.token ?? "", null)).toBe(true);
    expect(await pending).toEqual({ status: "suspended", wakeAt: "2026-10-16T01:00:00.000Z" });
    expect((await f.store.getRun("run"))?.wakeAt).toBe("2026-10-16T01:00:00.000Z");
  });
}
