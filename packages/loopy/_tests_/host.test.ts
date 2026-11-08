import { expect, test } from "bun:test";
import type { Executor } from "@loopy/core";
import { initialState, step } from "@loopy/core/engine";
import { activate } from "@loopy/runtime/host";
import { code, loopy, sh } from "@loopy/sdk/graph";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { newRun } from "./fixture";
import { RetryGateStore } from "./host-policy-fixture";
import { MemorySqlStore } from "./store-fixture";

function graph() {
  const graph = loopy("test", {
    input: {},
    run: () =>
      code("work", {
        in: {},
        out: { kind: "value", type: "number" },
        module: "./work.ts",
      }),
  });

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}

test.each(["none", "finished"] as const)(
  "resumes persisted attempt from %s receipt",
  async (kind) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = new MemorySqlStore();
        const plan = graph();
        yield* store.createRun(newRun());
        yield* store.claim("run", "old");

        const node = step(plan, initialState("run", {}), {
          kind: "run_started",
          at: newRun().createdAt,
        }).state.nodeRuns[0];

        if (!node) {
          throw new Error("Expected running node.");
        }

        yield* store.apply({
          runId: "run",
          token: "old",
          effects: [{ kind: "write_node_run", nodeRun: { ...node, attempt: 2 } }],
        });
        yield* store.release("run", "old");
        let executions = 0;

        const result = {
          kind: "succeeded" as const,
          output: 42,
          logs: [{ message: "result", data: null }],
        };

        const executor: Executor = {
          lookup: (key, attempt) =>
            Effect.sync(() => {
              expect(key).toEqual(node.key);
              expect(attempt).toBe(2);

              return kind === "finished" ? { kind, result } : { kind };
            }),
          execute: (key, attempt) =>
            Effect.sync(() => {
              expect(key).toEqual(node.key);
              expect(attempt).toBe(2);
              executions++;

              return result;
            }),
        };

        expect(yield* activate({ runId: "run", store, graph: plan, executor })).toEqual({
          status: "succeeded",
          output: 42,
        });
        expect(executions).toBe(kind === "none" ? 1 : 0);
        expect(yield* store.getNodeRuns("run")).toMatchObject([
          { attempt: 2, status: "succeeded", receipt: "finished" },
          { status: "succeeded" },
        ]);
        expect(yield* store.getLogs("run")).toHaveLength(1);
      }),
    );
  },
);

for (const mode of ["retry", "rate"] as const) {
  test(`${mode} retains ownership and attempt while sleeping`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const base = Date.parse(newRun().createdAt);
        yield* TestClock.setTime(base);
        const waiting = yield* Deferred.make<void>();

        const store = new RetryGateStore(waiting);
        const attempts: number[] = [];

        const plan =
          mode === "retry"
            ? graph()
            : loopy("limited", {
                input: {},
                run: () => {
                  const rateLimit = { key: "shared", limit: 2, window: "1m" } as const;
                  sh(["printf", "first"], { rateLimit });
                  sh(["printf", "second"], { rateLimit });

                  return sh(["printf", "third"], { rateLimit });
                },
              });

        const executor: Executor = {
          lookup: () => Effect.succeed({ kind: "none" }),
          execute: (...[, attempt]) =>
            Effect.sync(() => {
              attempts.push(attempt);

              return mode === "retry" && attempt === 1
                ? {
                    kind: "failed" as const,
                    error: { code: "execution" as const, message: "Temporary." },
                    exitCode: null,
                    logs: [{ message: "first", data: null }],
                  }
                : {
                    kind: "succeeded" as const,
                    output: mode === "retry" ? 42 : { stdout: "ok", stderr: "", exitCode: 0 },
                    logs: [{ message: "second", data: null }],
                  };
            }),
        };

        yield* store.createRun(newRun());

        const running = yield* Effect.forkChild(
          activate({ runId: "run", store, graph: plan, executor }),
        );

        yield* Deferred.await(waiting);
        yield* Effect.yieldNow;
        expect(yield* store.getRun("run")).toMatchObject({
          status: "running",
          owner: { token: expect.any(String) },
          nextRetryAt: new Date(base + (mode === "retry" ? 1000 : 60_000)).toISOString(),
        });
        expect(attempts).toEqual(mode === "retry" ? [1] : [1, 1]);
        yield* TestClock.adjust(mode === "retry" ? 1000 : 60_000);
        expect(yield* Fiber.join(running)).toMatchObject({ status: "succeeded" });
        expect(attempts).toEqual(mode === "retry" ? [1, 2] : [1, 1, 1]);
        expect((yield* store.getRun("run"))?.nextRetryAt).toBeUndefined();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
}
