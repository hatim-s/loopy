import { expect, test } from "bun:test";
import hello from "../../../examples/hello.loopy.ts";
import review from "../../../examples/review.loopy.ts";
import { MemoryRunStore } from "../src/runtime/index.js";
import { FakeExecutor, startLoopy } from "./fixture.js";

test("hello records a durable greeting and its log", async () => {
  const store = new MemoryRunStore();
  const executor = new FakeExecutor();
  expect(
    await startLoopy({
      loopy: hello,
      input: { name: "Hatim", enthusiastic: true },
      store,
      executor,
      runId: "hello",
      bundleHash: "fixture",
      workspace: "/workspace",
    }),
  ).toEqual({ status: "succeeded", output: { greeting: "Hello, Hatim!" } });
  expect(await store.getSteps("hello")).toMatchObject([
    { key: "greet", kind: "function", output: "Hello, Hatim!" },
  ]);
  expect(await store.getLogs("hello")).toMatchObject([{ message: "Hello, Hatim!" }]);
  expect(executor.calls).toEqual([]);
});

for (const changed of [false, true]) {
  test(`review ${changed ? "calls Codex with the diff" : "skips Codex for a clean checkout"}`, async () => {
    const store = new MemoryRunStore();
    const executor = new FakeExecutor();
    executor.execute = async (command, options) => {
      executor.calls.push(command);
      executor.options.push(options);

      return {
        ...executor.result,
        stdout: command.args.includes("--numstat")
          ? changed
            ? "2\t0\tsrc/app.ts\0"
            : ""
          : command.program === "git"
            ? "diff --git a/src/app.ts b/src/app.ts\n+new code"
            : "Found an issue.",
      };
    };

    const options = {
      loopy: review,
      store,
      executor,
      runId: "review",
      bundleHash: "fixture",
      workspace: "/workspace",
    };

    expect(
      await startLoopy({ ...options, input: { instructions: "Check correctness." } }),
    ).toMatchObject({ status: "succeeded", output: { outcome: changed ? "reviewed" : "clean" } });
    expect(executor.calls.map((command) => command.program)).toEqual(
      changed ? ["git", "git", "codex"] : ["git"],
    );

    if (changed) {
      expect(executor.calls[2]).toMatchObject({
        args: ["exec", "--sandbox", "read-only", "--", "-"],
        stdin:
          "Review these changes without editing files.\ndiff --git a/src/app.ts b/src/app.ts\n+new code\nCheck correctness.",
      });
    }

    expect(await store.getLogs("review")).toHaveLength(1);
  });
}
