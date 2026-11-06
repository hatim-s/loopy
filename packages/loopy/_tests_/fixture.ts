import { Effect } from "effect";
import {
  type ExecutionResult,
  type ExecutionSpec,
  type Executor,
  ExecutorError,
  type RunRecord,
} from "../src/core";

export class FakeExecutor implements Executor {
  calls: ExecutionSpec[] = [];
  result: ExecutionResult = { kind: "succeeded", output: null, logs: [] };
  failure: Error | null = null;
  lookup() {
    return Effect.succeed({ kind: "none" as const });
  }
  execute(...args: Parameters<Executor["execute"]>) {
    const [, , spec] = args;

    return Effect.suspend(() => {
      this.calls.push(spec);

      if (this.failure) {
        return Effect.fail(new ExecutorError({ operation: "execute", cause: this.failure }));
      }

      return Effect.succeed(this.result);
    });
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
