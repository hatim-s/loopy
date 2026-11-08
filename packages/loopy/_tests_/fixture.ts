import {
  type ExecutionResult,
  type ExecutionSpec,
  type Executor,
  ExecutorError,
  type RunRecord,
  type RunStatus,
} from "@loopy/core";
import { Effect } from "effect";

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

export function newRun(): Extract<RunRecord, { status: "queued" }> {
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

/** A stored run in `status` with the outcome fields that status requires. */
export function runIn(status: RunStatus, base: Omit<RunRecord, "status">): RunRecord {
  switch (status) {
    case "succeeded":
      return { ...base, status, output: null };
    case "failed":
      return { ...base, status, error: "controlled" };
    case "suspended":
      return { ...base, status, wakeAt: null };
    default:
      return { ...base, status };
  }
}
