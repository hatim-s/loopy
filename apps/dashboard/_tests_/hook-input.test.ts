import { expect, test } from "bun:test";
import { activate, MemoryRunStore } from "loopy/runtime";
import { hookInput } from "../src/lib/hook-input.ts";

const AT = "2026-10-17T10:00:00.000Z";

// The schema mirrors what runtime/hook.ts writes, so read the step the runtime itself stores.
async function storedHookInput() {
  const store = new MemoryRunStore(() => Date.parse(AT));

  await store.createRun({
    id: "run",
    slug: "approve",
    bundleHash: "bundle",
    workspace: "/workspace",
    input: null,
    status: "queued",
    createdAt: AT,
    updatedAt: AT,
  });

  await activate({
    store,
    runId: "run",
    workflow: async (ctx) => ctx.hook("approve", { timeout: "1h" }),
    clock: { now: () => Date.parse(AT), timeout: () => () => {} },
    executor: { execute: () => Promise.reject(new Error("No commands in this workflow.")) },
    cwd: "/workspace",
    mode: "sandbox",
  });

  const [step] = await store.getSteps("run");

  return step;
}

test("a hook step stored by the runtime parses to its name and token", async () => {
  const step = await storedHookInput();

  expect(step?.kind).toBe("hook");
  expect(step && hookInput(step.input)).toEqual({ name: "approve", token: expect.any(String) });
});

test("step input of another shape is not a hook input", () => {
  expect(hookInput(null)).toBeNull();
  expect(hookInput({ name: "approve" })).toBeNull();
  expect(hookInput({ name: "approve", token: "t", timeout: "1h" })).toBeNull();
});
