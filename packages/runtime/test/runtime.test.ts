import { describe, expect, test } from "bun:test";
import {
  createTestIds,
  DeterministicFakeProvider,
  DeterministicVerifier,
  InMemoryRuntimeStore,
} from "../../testing/src/index.ts";
import { RuntimeScheduler, replayEvents } from "../src/index.ts";

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

  test("replays persisted events in sequence without executing", () => {
    const frames = replayEvents([
      { sequence: 2, type: "later", runId: "r", occurredAt: "" },
      { sequence: 0, type: "first", runId: "r", occurredAt: "" },
    ]);
    expect(frames.map((frame) => frame.event.type)).toEqual(["first", "later"]);
  });

  test("forks from a completed checkpoint without rerunning its prefix", async () => {
    const x = scheduler();
    const workflow = plan([agent("a"), agent("b")], [{ id: "ab", source: "a", target: "b" }]);
    const source = await x.runtime.run(workflow);
    const forked = await x.runtime.fork(source.run.runId, "a");
    const result = await x.runtime.wait(forked.runId);
    expect(result.run.status).toBe("succeeded");
    expect(x.provider.calls.map((call) => call.nodeId)).toEqual(["a", "b", "b"]);
  });

  test("carries graph-safe completed side effects after a checkpoint", async () => {
    const x = scheduler();
    const workflow = plan(
      [agent("start"), agent("effect"), agent("end")],
      [
        { id: "se", source: "start", target: "effect" },
        { id: "ee", source: "effect", target: "end" },
      ],
    );
    workflow.nodes[1] = { ...workflow.nodes[1], sideEffect: true };
    const source = await x.runtime.run(workflow);
    const forked = await x.runtime.fork(source.run.runId, "start");
    const result = await x.runtime.wait(forked.runId);
    expect(result.run.status).toBe("succeeded");
    expect(x.provider.calls.map((call) => call.nodeId)).toEqual(["start", "effect", "end", "end"]);
  });

  test("fails closed for an unselected completed side-effect branch", async () => {
    const x = scheduler();
    const workflow = plan(
      [
        agent("start"),
        {
          id: "route",
          kind: "route",
          predicate: {
            kind: "comparison",
            operator: "equals",
            left: { kind: "reference", reference: { kind: "workflow_input", name: "go" } },
            right: { kind: "literal", value: true },
          },
        },
        { ...agent("unsafe"), sideEffect: true },
        agent("safe"),
      ],
      [
        { id: "sr", source: "start", target: "route" },
        { id: "ru", source: "route", target: "unsafe", label: "false" },
        { id: "rs", source: "route", target: "safe", label: "true" },
      ],
    );
    const source = await x.runtime.run(workflow, { go: false });
    await expect(x.runtime.fork(source.run.runId, "start", { go: true })).rejects.toThrow(
      /unsafe.*side effect/,
    );
  });

  test("carries the resolved approval evidence with an approval checkpoint", async () => {
    const x = scheduler();
    const workflow = plan(
      [{ id: "approval", kind: "approval", message: "Ship?", approvalKey: "ship" }, agent("end")],
      [{ id: "ae", source: "approval", target: "end" }],
    );
    const source = await x.runtime.start(workflow);
    await Bun.sleep(10);
    await x.runtime.approve(source.runId, "approval", "approved");
    const completed = await x.runtime.wait(source.runId);
    const forked = await x.runtime.fork(source.runId, "approval");
    const approval = (await x.runtime.snapshot(forked.runId)).approvals.find(
      (item) => item.nodeId === "approval",
    );
    expect(approval).toMatchObject({
      runId: forked.runId,
      nodeId: "approval",
      key: "ship",
      decision: "approved",
    });
    expect(approval?.attemptId).toBe(
      (await x.runtime.snapshot(forked.runId)).attempts.find((item) => item.nodeId === "approval")
        ?.attemptId,
    );
    expect(completed.approvals[0]?.decision).toBe("approved");
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

  test("cancellation terminalizes blocked work and ignores a late provider success", async () => {
    const x = scheduler();
    x.provider.defer("a");
    const workflow = plan(
      [agent("a"), { id: "approval", kind: "approval", message: "Ship?" }],
      [],
      { topology: { startNodeIds: ["a", "approval"], terminalNodeIds: ["a", "approval"] } },
    );
    const started = await x.runtime.start(workflow);
    await Bun.sleep(10);
    await x.runtime.cancel(started.runId);
    const cancelled = await x.runtime.wait(started.runId);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.attempts.every((attempt) => attempt.status === "cancelled")).toBe(true);
    const active = x.provider.calls[0];
    if (!active) throw new Error("expected active provider call");
    x.provider.release(active.attemptId, { status: "succeeded", outputs: { late: true } });
    await Bun.sleep(5);
    const after = await x.runtime.snapshot(started.runId);
    expect(after.run.status).toBe("cancelled");
    expect(after.attempts.find((attempt) => attempt.attemptId === active.attemptId)?.status).toBe(
      "cancelled",
    );
  });

  test("cancellation does not await a throwing provider cleanup hook", async () => {
    const provider = new DeterministicFakeProvider();
    provider.defer("a");
    let cleanupCalls = 0;
    provider.cancel = () => {
      cleanupCalls += 1;
      throw new Error("cleanup failed");
    };
    const x = scheduler(provider);
    const started = await x.runtime.start(plan([agent("a")], []));
    await Bun.sleep(10);
    const active = provider.calls[0];
    if (!active) throw new Error("expected active provider call");

    const cancelled = await x.runtime.cancel(started.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cleanupCalls).toBe(1);
    provider.release(active.attemptId, { status: "succeeded", outputs: { late: true } });
    await Bun.sleep(5);
    expect((await x.runtime.snapshot(started.runId)).run.status).toBe("cancelled");
    expect((await x.runtime.snapshot(started.runId)).attempts[0]?.status).toBe("cancelled");
  });

  test("cancellation does not await a never-resolving provider cleanup hook", async () => {
    const provider = new DeterministicFakeProvider();
    provider.defer("a");
    let cleanupCalls = 0;
    provider.cancel = () => {
      cleanupCalls += 1;
      return new Promise<void>(() => {});
    };
    const x = scheduler(provider);
    const started = await x.runtime.start(plan([agent("a")], []));
    await Bun.sleep(10);
    const active = provider.calls[0];
    if (!active) throw new Error("expected active provider call");

    const cancelled = await Promise.race([
      x.runtime.cancel(started.runId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cancellation timed out")), 100),
      ),
    ]);
    expect(cancelled.status).toBe("cancelled");
    expect(cleanupCalls).toBe(1);
    provider.release(active.attemptId, { status: "succeeded", outputs: { late: true } });
    await Bun.sleep(5);
    expect((await x.runtime.snapshot(started.runId)).run.status).toBe("cancelled");
    expect((await x.runtime.snapshot(started.runId)).attempts[0]?.status).toBe("cancelled");
  });

  test("cross-process cancellation remains non-terminal without owner observation", async () => {
    const owner = new DeterministicFakeProvider();
    owner.defer("a");
    const first = scheduler(owner);
    const started = await first.runtime.start(plan([agent("a")], []));
    await Bun.sleep(10);

    const other = new RuntimeScheduler({
      store: first.store,
      provider: new DeterministicFakeProvider(),
    });
    const result = await other.cancel(started.runId, "operator request");

    expect(result.status).toBe("cancelling");
    expect(owner.cancelled).toEqual(new Set());
    expect((await first.runtime.snapshot(started.runId)).run.status).toBe("cancelling");

    const ownerResult = await first.runtime.cancel(started.runId, "operator request");
    expect(owner.cancelled.size).toBe(1);
    expect(ownerResult.status).toBe("cancelled");
  });

  test("an impossible all join fails instead of succeeding", async () => {
    const x = scheduler();
    x.provider.fail("a", "branch failed");
    const workflow = plan(
      [agent("start"), agent("a"), agent("b"), { id: "join", kind: "join", policy: "all" }],
      [
        { id: "sa", source: "start", target: "a" },
        { id: "sb", source: "start", target: "b" },
        { id: "aj", source: "a", target: "join" },
        { id: "bj", source: "b", target: "join" },
      ],
    );
    const result = await x.runtime.run(workflow);
    expect(result.run.status).toBe("failed");
    expect(result.attempts.find((attempt) => attempt.nodeId === "join")?.status).toBe("failed");
  });

  test("join output modes retain graph predecessor order", async () => {
    const x = scheduler();
    x.provider.succeed("a", { branch: "a" });
    x.provider.succeed("b", { branch: "b" });
    const workflow = plan(
      [
        agent("start"),
        agent("a"),
        agent("b"),
        { id: "join", kind: "join", policy: "all", outputMode: "object" },
      ],
      [
        { id: "sa", source: "start", target: "a" },
        { id: "sb", source: "start", target: "b" },
        { id: "aj", source: "a", target: "join" },
        { id: "bj", source: "b", target: "join" },
      ],
    );
    const result = await x.runtime.run(workflow);
    const join = result.attempts.find((attempt) => attempt.nodeId === "join");
    expect(join?.output?.branches).toEqual({ a: { branch: "a" }, b: { branch: "b" } });
  });

  test("approval decisions are compare-and-set and only one concurrent decision wins", async () => {
    const x = scheduler();
    const workflow = plan([{ id: "approval", kind: "approval", message: "Ship?" }], []);
    const started = await x.runtime.start(workflow);
    await Bun.sleep(10);
    const decisions = await Promise.allSettled([
      x.runtime.approve(started.runId, "approval", "approved"),
      x.runtime.approve(started.runId, "approval", "rejected"),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);
    const snapshot = await x.runtime.snapshot(started.runId);
    expect(snapshot.attempts.find((attempt) => attempt.nodeId === "approval")?.status).toBe(
      "succeeded",
    );
  });

  test("retrying a terminal failed run atomically resumes it with one new attempt", async () => {
    const x = scheduler();
    x.provider.fail("a", "first failure");
    const workflow = plan([agent("a")], []);
    const started = await x.runtime.start(workflow);
    const failed = await x.runtime.wait(started.runId);
    expect(failed.run.status).toBe("failed");
    x.provider.succeed("a", { recovered: true });
    const retried = await x.runtime.retry(started.runId, "a");
    expect(retried.attempt).toBe(2);
    expect((await x.runtime.wait(started.runId)).run.status).toBe("succeeded");
    expect(
      (await x.store.listAttempts(started.runId)).filter((a) => a.nodeId === "a"),
    ).toHaveLength(2);
  });

  test("run events carry the real workflow id and stable execution plan hash", async () => {
    const x = scheduler();
    const workflow = plan([agent("a")], []);
    const started = await x.runtime.start(workflow);
    const events = await x.store.listEvents(started.runId);
    expect(events[0]?.payload?.workflowId).toBe(workflow.id);
    expect(events[0]?.payload?.executionPlanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(events[1]?.payload?.executionPlanHash).toBe(events[0]?.payload?.executionPlanHash);
  });
});
