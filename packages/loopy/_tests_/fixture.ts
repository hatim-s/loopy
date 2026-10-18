import type { ExecutionResult, ExecutionSpec, Executor, RunRecord } from "../src/core/index.js";

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
