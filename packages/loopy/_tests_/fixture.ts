import type { CommandResult, Json, RunRecord } from "../src/core/index.js";
import {
  type ActivationOptions,
  activate,
  type Clock,
  type Executor,
  MemoryRunStore,
  type ResolvedCommand,
  type WorkflowContext,
} from "../src/runtime/index.js";
import { activateLoopy, createLoopyRun } from "../src/sdk/host.js";

export class FakeExecutor implements Executor {
  calls: ResolvedCommand[] = [];
  result: CommandResult = { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
  failure?: Error;
  options: Parameters<Executor["execute"]>[1][] = [];
  async execute(
    command: ResolvedCommand,
    options: Parameters<Executor["execute"]>[1],
  ): Promise<CommandResult> {
    this.calls.push(command);
    this.options.push(options);

    if (this.failure) {
      throw this.failure;
    }

    return this.result;
  }
}

function testClock() {
  let time = Date.parse("2026-10-16T00:00:00.000Z");
  const timers = new Map<() => void, number>();

  const clock: Clock = {
    now: () => time,
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

  return { clock, advance, timers };
}

export function newRun(): RunRecord {
  return {
    id: "run",
    slug: "test",
    revision: "bundle",
    workspace: "/workspace",
    input: { value: 42 },
    status: "queued",
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
}

export async function fixture(store = new MemoryRunStore()) {
  const { clock, advance, timers } = testClock();
  const run = newRun();
  const executor = new FakeExecutor();
  await store.createRun(run);

  function execute(
    workflow: (context: WorkflowContext) => Promise<Json>,
    signal?: AbortSignal,
    options: Pick<ActivationOptions, "rateLimits"> = {},
  ) {
    return activate({
      ...options,
      runId: run.id,
      store,
      executor,
      workflow,
      signal,
      cwd: "/workspace",
      mode: "sandbox",
      clock,
    });
  }

  return { run, store, executor, execute, advance, timers, clock };
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function startLoopy<Input, Output extends Json>(
  options: Parameters<typeof createLoopyRun<Input, Output>>[0] &
    Pick<Parameters<typeof activateLoopy<Input, Output>>[0], "executor" | "signal">,
) {
  await createLoopyRun(options);

  return activateLoopy(options);
}
