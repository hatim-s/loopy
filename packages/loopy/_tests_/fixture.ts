import type { ExecutionResult, ExecutionSpec, Executor, RunRecord } from "../src/core/index.js";
import { type Clock, SYSTEM_CLOCK } from "../src/host/index.js";
import { code, loopy } from "../src/sdk/graph/index.js";

export class FakeExecutor implements Executor {
  calls: ExecutionSpec[] = [];
  result: ExecutionResult = { kind: "succeeded", output: null, logs: [] };
  failure: Error | null = null;
  async lookup() {
    return { kind: "none" as const };
  }
  async execute(...args: Parameters<Executor["execute"]>) {
    const [, , spec] = args;
    this.calls.push(spec);

    if (this.failure) {
      throw this.failure;
    }

    return this.result;
  }
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

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FakeClock implements Clock {
  private time: number;
  private readonly timers = new Set<{ at: number; callback: () => void }>();
  readonly sleeps: number[] = [];

  constructor(now = Date.parse(newRun().createdAt)) {
    this.time = now;
  }

  now = () => this.time;

  timeout = (callback: () => void, milliseconds: number) => {
    const timer = { at: this.time + milliseconds, callback };
    this.timers.add(timer);

    if (milliseconds <= 0) {
      queueMicrotask(() => {
        if (this.timers.delete(timer)) {
          callback();
        }
      });
    }

    return () => {
      this.timers.delete(timer);
    };
  };

  sleep(milliseconds: number, signal: AbortSignal) {
    this.sleeps.push(milliseconds);

    return SYSTEM_CLOCK.sleep.call(this, milliseconds, signal);
  }

  advance(milliseconds: number) {
    this.time += milliseconds;

    for (const timer of this.timers) {
      if (timer.at <= this.time) {
        this.timers.delete(timer);
        timer.callback();
      }
    }
  }
}

export async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await ready()) {
      return;
    }

    await Bun.sleep(1);
  }

  throw new Error("The expected state was not reached.");
}

export function codeGraph() {
  const graph = loopy("test", {
    input: {},
    run: () =>
      code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" }),
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}
