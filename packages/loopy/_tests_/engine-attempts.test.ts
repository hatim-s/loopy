import { expect, test } from "bun:test";
import { CommandExitError, type LoopyContext, MemoryRunStore } from "../src/runtime/index.js";
import { fixture } from "./engine-fixture.js";

test("step logs retain each of three attempts and expose only scoped context", async () => {
  const f = await fixture();

  const workflow = (ctx: LoopyContext) =>
    ctx.step("retry", (scope) => {
      expect(Object.keys(scope).sort()).toEqual(["attempt", "log"]);
      scope.log.info("attempt", scope.attempt);

      if (scope.attempt < 3) {
        throw new Error("Temporary failure. Retry the step.");
      }

      return 42;
    });

  expect((await f.execute(workflow)).status).toBe("suspended");
  await f.execute(workflow);
  f.advance(1000);
  expect((await f.execute(workflow)).status).toBe("suspended");
  f.advance(2000);
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: 42 });
  expect((await f.store.getLogs("run")).map((log) => [log.position, log.data])).toEqual(
    [1, 2, 3].map((attempt) => [{ kind: "step", seq: 1, attempt, index: 1 }, attempt]),
  );
});

test("crash recovery retains logs of the original and recovered step attempts", async () => {
  const f = await fixture(new MemoryRunStore());
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
  await f.store.appendLog("run", "crashed", {
    runId: "run",
    seq: 1,
    position: { kind: "step", seq: 1, attempt: 1, index: 1 },
    level: "info",
    message: "original",
    at: f.run.createdAt,
  });
  await f.store.release("run", "crashed");
  expect(
    await f.execute(async (ctx) =>
      ctx.step("recover", ({ log, attempt }) => {
        log.info("recovered");

        return attempt;
      }),
    ),
  ).toEqual({ status: "succeeded", output: 2 });
  expect((await f.store.getLogs("run")).map((log) => log.message)).toEqual([
    "original",
    "recovered",
  ]);
});

test("command exit errors omit empty stderr and retain the last 500 characters", () => {
  const result = { exitCode: 1, stdout: "", stderr: "", durationMs: 1 };
  expect(new CommandExitError(result).message).toBe(
    "Command exited with code 1. Correct the command.",
  );
  const stderr = `${"x".repeat(600)}last failure`;
  expect(new CommandExitError({ ...result, stderr }).message).toBe(
    `Command exited with code 1: ${stderr.slice(-500)}. Inspect stderr and correct the command.`,
  );
});

test("abort suspends an in-flight function step and retries it immediately on resume", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<number>();
  const controller = new AbortController();

  const workflow = (ctx: LoopyContext) =>
    ctx.step(
      "hold",
      ({ attempt }) => {
        if (attempt > 1) {
          return 42;
        }

        entered.resolve();

        return pending.promise;
      },
      { retry: { attempts: 1 } },
    );

  const running = f.execute(workflow, controller.signal);
  await entered.promise;
  controller.abort();
  expect(await running).toEqual({
    status: "suspended",
    wakeAt: new Date(f.clock.now()).toISOString(),
  });
  expect(await f.store.getSteps("run")).toMatchObject([
    { status: "retrying", attempt: 1, nextRetryAt: new Date(f.clock.now()).toISOString() },
  ]);
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
  expect(await f.execute(workflow)).toEqual({ status: "succeeded", output: 42 });
  pending.resolve(1);
  expect(await f.store.getSteps("run")).toMatchObject([
    { status: "succeeded", attempt: 2, output: 42 },
  ]);
});
