import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RuntimeScheduler, type RuntimeStoreCommand } from "../../runtime/src/index.js";
import { createTestIds, DeterministicFakeProvider } from "../../testing/src/index.js";
import { encodeTraceJsonl, importTraceJsonl } from "../../tracing/src/index.js";
import { SqliteRuntimeStore, Storage } from "../src/index.js";

const ids = createTestIds();
const project = () => mkdtempSync(join(tmpdir(), "loopy-phase1-e2e-"));
const agent = (id: string) => ({ id, kind: "agent", name: id, prompt: id });
const plan = (nodes: Record<string, unknown>[], edges: Record<string, unknown>[], extra = {}) => ({
  id: ids(),
  workflowVersion: 1,
  nodes,
  edges,
  policies: { concurrency: { maxParallel: 4 } },
  ...extra,
});
function opened() {
  const storage = new Storage({ projectDir: project() });
  const provider = new DeterministicFakeProvider();
  const store = new SqliteRuntimeStore(storage);
  const runtime = new RuntimeScheduler({ store, provider, id: ids });
  return { storage, provider, store, runtime };
}

class CrashAfterReadyStore extends SqliteRuntimeStore {
  persistedReady = false;

  override async commit(commands: readonly RuntimeStoreCommand[]): Promise<void> {
    await super.commit(commands);
    if (
      !this.persistedReady &&
      commands.some(
        (command) => command.type === "create_attempt" && command.attempt.status === "ready",
      )
    ) {
      this.persistedReady = true;
      await new Promise<void>(() => {});
    }
  }
}

describe("SQLite Phase 1 runtime adapter", () => {
  test("persists linear and selected branch execution with one event sequence", async () => {
    const x = opened();
    const workflow = plan(
      [
        agent("start"),
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
        { id: "sr", source: "start", target: "route" },
        { id: "ry", source: "route", target: "yes", label: "true" },
        { id: "rn", source: "route", target: "no", label: "false" },
      ],
    );
    const result = await x.runtime.run(workflow, { go: true });
    expect(result.run.status).toBe("succeeded");
    expect(result.attempts.find((a) => a.nodeId === "no")?.status).toBe("skipped");
    expect(result.events.map((event) => event.sequence)).toEqual([...result.events.keys()]);
    expect(
      x.store.listTraceEvents(result.run.runId).every((event) => event.schemaVersion === "1"),
    ).toBe(true);
    x.storage.close();
  });

  test("joins parallel branches after the slower branch and survives reopen", async () => {
    const x = opened();
    x.provider.set("a", async () => {
      await Bun.sleep(20);
      return { status: "succeeded", outputs: { a: 1 } };
    });
    x.provider.set("b", async () => {
      await Bun.sleep(1);
      return { status: "succeeded", outputs: { b: 1 } };
    });
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
    const result = await x.runtime.run(workflow);
    expect(result.run.status).toBe("succeeded");
    expect(result.attempts.find((a) => a.nodeId === "join")?.status).toBe("succeeded");
    const runId = result.run.runId;
    x.storage.close();
    const reopened = new Storage({ projectDir: x.storage.projectDir });
    expect((await new SqliteRuntimeStore(reopened).getRun(runId))?.status).toBe("succeeded");
    reopened.close();
  });

  test("reopens and executes a persisted ready attempt exactly once", async () => {
    const storage = new Storage({ projectDir: project() });
    const crashingStore = new CrashAfterReadyStore(storage);
    const staleProvider = new DeterministicFakeProvider();
    const staleRuntime = new RuntimeScheduler({
      store: crashingStore,
      provider: staleProvider,
      id: ids,
    });
    const workflow = plan([agent("a")], []);
    const started = await staleRuntime.start(workflow);
    while (!crashingStore.persistedReady) await Bun.sleep(1);
    expect(await crashingStore.listAttempts(started.runId)).toHaveLength(1);
    expect((await crashingStore.listAttempts(started.runId))[0]?.status).toBe("ready");
    expect(staleProvider.calls).toHaveLength(0);
    storage.close();

    const reopened = new Storage({ projectDir: storage.projectDir });
    const provider = new DeterministicFakeProvider();
    const store = new SqliteRuntimeStore(reopened);
    const runtime = new RuntimeScheduler({ store, provider, id: ids });
    expect((await runtime.recover())[0]?.status).toBe("paused");
    await runtime.resume(started.runId);
    const result = await runtime.wait(started.runId);
    expect(result.run.status).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.status).toBe("succeeded");
    expect(result.events.filter((event) => event.type === "node.ready")).toHaveLength(1);
    reopened.close();
  });

  test("persists approval, pause/cancel, retry, and atomic recovery transitions", async () => {
    const x = opened();
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
    await Bun.sleep(30);
    expect(
      (await x.runtime.snapshot(started.runId)).attempts.find((a) => a.nodeId === "approve")
        ?.status,
    ).toBe("blocked_approval");
    await x.runtime.approve(started.runId, "approve", "approved");
    expect((await x.runtime.wait(started.runId)).run.status).toBe("succeeded");
    const retry = opened();
    retry.provider.set(
      "retry",
      { status: "failed", error: "provider_error" },
      { status: "succeeded", outputs: { ok: true } },
    );
    const retryResult = await retry.runtime.run(
      plan([{ ...agent("retry"), retry: { maxAttempts: 2, retryOn: ["provider_error"] } }], []),
    );
    expect(retryResult.run.status).toBe("succeeded");
    expect(retryResult.attempts.filter((a) => a.nodeId === "retry")).toHaveLength(2);

    const deferred = opened();
    deferred.provider.defer("slow");
    const active = await deferred.runtime.start(plan([agent("slow")], []));
    await Bun.sleep(10);
    await deferred.runtime.pause(active.runId);
    await deferred.runtime.cancel(active.runId);
    expect((await deferred.runtime.wait(active.runId)).run.status).toBe("cancelled");
    const orphan = await deferred.store.listAttempts(active.runId);
    expect(orphan[0]?.status).toBe("cancelled");
    x.storage.close();
    retry.storage.close();
    deferred.storage.close();
  });

  test("recovery marks an orphan failed and trace JSONL round-trips into a fresh database", async () => {
    const x = opened();
    x.provider.defer("a");
    const workflow = plan([agent("a")], []);
    const started = await x.runtime.start(workflow);
    await Bun.sleep(10);
    const before = x.provider.calls.length;
    const recovered = await new RuntimeScheduler({
      store: x.store,
      provider: new DeterministicFakeProvider(),
      id: ids,
    }).recover();
    expect(recovered[0]?.status).toBe("paused");
    expect((await x.store.listAttempts(started.runId))[0]?.status).toBe("failed");
    expect(x.provider.calls).toHaveLength(before);

    const events = x.store.listTraceEvents(started.runId);
    const text = encodeTraceJsonl(events);
    const fresh = opened();
    await importTraceJsonl(text, fresh.store.traceSink(events[0]?.runId ?? started.runId));
    expect(encodeTraceJsonl(fresh.store.listTraceEvents(events[0]?.runId ?? started.runId))).toBe(
      text,
    );
    x.storage.close();
    fresh.storage.close();
  });
});
