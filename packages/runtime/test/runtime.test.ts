import { describe, expect, test } from "bun:test";
import {
  createTestIds,
  DeterministicFakeProvider,
  DeterministicVerifier,
  InMemoryRuntimeStore,
} from "../../testing/src/index.ts";
import { RuntimeScheduler } from "../src/index.ts";

const ids = createTestIds();
function scheduler(
  provider = new DeterministicFakeProvider(),
  verifier = new DeterministicVerifier(),
) {
  const store = new InMemoryRuntimeStore();
  return {
    store,
    provider,
    verifier,
    runtime: new RuntimeScheduler({ store, provider, verifier, id: ids }),
  };
}
function plan(
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `workflow-${ids()}`,
    workflowVersion: 1,
    nodes,
    edges,
    policies: { concurrency: { maxParallel: 4 } },
    ...extra,
  };
}
const agent = (id: string) => ({ id, kind: "agent", name: id, prompt: id });
const verify = (id: string) => ({ id, kind: "verify", name: id, commands: [{ command: "check" }] });

describe("phase 1 runtime", () => {
  test("runs a linear workflow once and verifies it", async () => {
    const x = scheduler();
    const workflow = plan([agent("a"), verify("v")], [{ id: "e", source: "a", target: "v" }]);
    const result = await x.runtime.run(workflow);
    expect(result.run.status).toBe("succeeded");
    expect(result.attempts.filter((a) => a.status === "succeeded")).toHaveLength(2);
  });

  test("routes only the safe predicate branch", async () => {
    const x = scheduler();
    const workflow = plan(
      [
        { ...agent("start"), provider: "codex" },
        {
          id: "route",
          kind: "route",
          name: "route",
          predicate: {
            kind: "comparison",
            operator: "equals",
            left: { kind: "reference", reference: { kind: "workflow_input", name: "go" } },
            right: { kind: "literal", value: true },
          },
        },
        agent("yes"),
        agent("no"),
      ],
      [
        { id: "sa", source: "start", target: "route" },
        { id: "ry", source: "route", target: "yes", label: "true" },
        { id: "rn", source: "route", target: "no", label: "false" },
      ],
    );
    const result = await x.runtime.run(workflow, { go: true });
    expect(result.run.status).toBe("succeeded");
    expect(x.provider.calls.map((call) => call.nodeId)).toEqual(["start", "yes"]);
    expect(result.attempts.find((a) => a.nodeId === "no")?.status).toBe("skipped");
  });

  test("waits for all join predecessors despite completion order", async () => {
    const provider = new DeterministicFakeProvider();
    const x = scheduler(provider);
    const workflow = plan(
      [
        agent("start"),
        agent("a"),
        agent("b"),
        { id: "join", kind: "join", name: "join", policy: "all" },
        agent("end"),
      ],
      [
        { id: "sa", source: "start", target: "a" },
        { id: "sb", source: "start", target: "b" },
        { id: "aj", source: "a", target: "join" },
        { id: "bj", source: "b", target: "join" },
        { id: "je", source: "join", target: "end" },
      ],
    );
    provider.set("a", async () => {
      await Bun.sleep(20);
      return { status: "succeeded", outputs: { a: 1 } };
    });
    provider.set("b", async () => {
      await Bun.sleep(1);
      return { status: "succeeded", outputs: { b: 1 } };
    });
    const result = await x.runtime.run(workflow);
    expect(result.run.status).toBe("succeeded");
    expect(result.attempts.find((a) => a.nodeId === "join")?.status).toBe("succeeded");
  });

  test("blocks on approval and resumes after approval", async () => {
    const x = scheduler();
    const workflow = plan(
      [
        agent("a"),
        { id: "approve", kind: "approval", name: "approve", message: "Ship?", approvalKey: "ship" },
        agent("end"),
      ],
      [
        { id: "aa", source: "a", target: "approve" },
        { id: "ae", source: "approve", target: "end" },
      ],
    );
    const started = await x.runtime.start(workflow);
    await Bun.sleep(20);
    expect(
      (await x.runtime.snapshot(started.runId)).attempts.find((a) => a.nodeId === "approve")
        ?.status,
    ).toBe("blocked_approval");
    await x.runtime.approve(started.runId, "approve", "approved");
    expect((await x.runtime.wait(started.runId)).run.status).toBe("succeeded");
  });

  test("retries a failed node as a new numbered attempt", async () => {
    const x = scheduler();
    x.provider.set(
      "a",
      { status: "failed", error: "provider_error" },
      { status: "succeeded", outputs: { ok: true } },
    );
    const workflow = plan(
      [{ ...agent("a"), retry: { maxAttempts: 2, retryOn: ["provider_error"] } }],
      [],
    );
    const result = await x.runtime.run(workflow);
    expect(result.run.status).toBe("succeeded");
    expect(
      result.attempts
        .filter((a) => a.nodeId === "a")
        .map((a) => a.attempt)
        .sort(),
    ).toEqual([1, 2]);
  });

  test("pause is a safe boundary and cancellation cancels the active provider", async () => {
    const x = scheduler();
    x.provider.defer("a");
    const workflow = plan([agent("a")], []);
    const started = await x.runtime.start(workflow);
    await Bun.sleep(10);
    await x.runtime.pause(started.runId);
    expect((await x.runtime.snapshot(started.runId)).run.status).toBe("pause_requested");
    const active = (await x.runtime.snapshot(started.runId)).attempts[0];
    expect(active).toBeDefined();
    if (!active) throw new Error("expected active attempt");
    await x.runtime.cancel(started.runId);
    expect(x.provider.cancelled.has(active.attemptId)).toBe(true);
    expect((await x.runtime.wait(started.runId)).run.status).toBe("cancelled");
  });

  test("recovery interrupts orphan attempts without replaying the provider", async () => {
    const x = scheduler();
    x.provider.defer("a");
    const workflow = plan([agent("a")], []);
    const started = await x.runtime.start(workflow);
    await Bun.sleep(10);
    const before = x.provider.calls.length;
    const fresh = new RuntimeScheduler({
      store: x.store,
      provider: new DeterministicFakeProvider(),
      id: ids,
    });
    const recovered = await fresh.recover();
    expect(recovered[0]?.status).toBe("paused");
    expect((await x.store.listAttempts(started.runId))[0]?.error).toContain("interrupted");
    expect(before).toBe(1);
  });
});
