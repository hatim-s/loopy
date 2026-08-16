import { describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventSchema } from "@loopy/contracts";
import {
  createProviderRegistry,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderRun,
  type ProviderSession,
} from "@loopy/providers";
import { createProviderExecutor } from "../src/provider-executor.ts";

const context = (extra: Record<string, unknown> = {}) => ({
  runId: "run-1",
  attemptId: "attempt-1",
  nodeId: "agent-1",
  node: { id: "agent-1", kind: "agent", provider: "codex", prompt: "hello" },
  input: {},
  signal: new AbortController().signal,
  ...extra,
});

function adapter(
  start: (request: ProviderRequest) => ProviderRun | Promise<ProviderRun>,
): ProviderAdapter {
  return {
    id: "codex",
    version: "fake-1",
    probe: async () => ({
      provider: "codex",
      available: true,
      capabilities: {
        schemaVersion: "1",
        capabilities: {},
        supported: [],
        degraded: [],
        unavailable: [],
      },
    }),
    capabilities: () => ({
      schemaVersion: "1",
      capabilities: {},
      supported: [],
      degraded: [],
      unavailable: [],
    }),
    start: start as ProviderAdapter["start"],
    historicalImports: [],
  };
}

const session: ProviderSession = { provider: "codex", sessionId: "session-1" };

describe("provider executor", () => {
  test("allocates unique monotonic sequences across sequential and parallel attempts", async () => {
    const stored: TraceEvent[] = [];
    let parallelAttemptsStarted = 0;
    let releaseParallelAttempts!: () => void;
    const bothParallelAttemptsStarted = new Promise<void>((resolve) => {
      releaseParallelAttempts = resolve;
    });
    const executor = createProviderExecutor({
      registry: createProviderRegistry([
        adapter(async (request) => ({
          session: Promise.resolve({
            provider: "codex",
            sessionId: `session-${request.attemptId}`,
          }),
          events: (async function* () {
            if (request.attemptId.startsWith("attempt-parallel")) {
              parallelAttemptsStarted += 1;
              if (parallelAttemptsStarted === 2) releaseParallelAttempts();
              await bothParallelAttemptsStarted;
            }
            yield {
              type: "session_started",
              provider: "fake",
              occurredAt: "2026-01-01T00:00:00.000Z",
              provenance: { sessionId: `session-${request.attemptId}` },
              payload: {},
            };
            yield {
              type: "message",
              provider: "fake",
              occurredAt: "2026-01-01T00:00:01.000Z",
              provenance: { sessionId: `session-${request.attemptId}` },
              payload: { role: "assistant", content: request.attemptId },
            };
            yield {
              type: "session_ended",
              provider: "fake",
              occurredAt: "2026-01-01T00:00:02.000Z",
              provenance: { sessionId: `session-${request.attemptId}` },
              payload: { status: "succeeded" },
            };
          })() as ProviderRun["events"],
          cancel: async () => {},
        })),
      ]),
      onEvent: (event) => {
        stored.push(event);
      },
    });

    await executor.execute(context({ attemptId: "attempt-sequential-1" }));
    await executor.execute(context({ attemptId: "attempt-sequential-2" }));
    await Promise.all([
      executor.execute(context({ attemptId: "attempt-parallel-1", nodeId: "agent-1" })),
      executor.execute(context({ attemptId: "attempt-parallel-2", nodeId: "agent-2" })),
    ]);

    expect(stored.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(stored.map((event) => event.sequence)).size).toBe(stored.length);
    expect(new Set(stored.map((event) => event.attemptId)).size).toBe(4);
    expect(stored.every((event) => event.runId === stored[0]?.runId)).toBe(true);
    expect(new Set(stored.map((event) => event.nodeId)).size).toBe(2);
  });

  test("persists canonical TraceEvent envelopes and preserves provider attribution", async () => {
    const events = [
      {
        type: "session_started",
        provider: "fake",
        occurredAt: new Date().toISOString(),
        provenance: { sessionId: "session-1" },
        payload: {},
      },
      {
        type: "message",
        provider: "fake",
        occurredAt: new Date().toISOString(),
        provenance: { sessionId: "session-1" },
        payload: { role: "assistant", content: "done" },
      },
      {
        type: "session_ended",
        provider: "fake",
        occurredAt: new Date().toISOString(),
        provenance: { sessionId: "session-1" },
        payload: { status: "succeeded" },
      },
    ];
    const stored: unknown[] = [];
    const executor = createProviderExecutor({
      registry: createProviderRegistry([
        adapter(async () => ({
          session: Promise.resolve(session),
          events: (async function* () {
            yield* events;
          })() as ProviderRun["events"],
          cancel: async () => {},
        })),
      ]),
      onEvent: (event) => {
        stored.push(event);
      },
    });
    const result = await executor.execute(context());
    expect(result.status).toBe("succeeded");
    expect(stored).toHaveLength(3);
    for (const event of stored) {
      const parsed = TraceEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.provider).toBe("codex");
      expect(parsed.success && parsed.data.runId).toBeTruthy();
      expect(parsed.success && parsed.data.nodeId).toBeTruthy();
    }
  });

  test("does not infer success when terminal provider evidence is absent", async () => {
    const executor = createProviderExecutor({
      registry: createProviderRegistry([
        adapter(async () => ({
          session: Promise.resolve(session),
          events: (async function* () {
            yield {
              type: "message",
              provider: "fake",
              occurredAt: new Date().toISOString(),
              provenance: { sessionId: "session-1" },
              payload: { role: "assistant", content: "maybe" },
            };
          })() as ProviderRun["events"],
          cancel: async () => {},
        })),
      ]),
    });
    const result = await executor.execute(context());
    expect(result).toMatchObject({ status: "failed" });
    expect(result.error).toContain("successful terminal evidence");
  });

  test("forwards merged policy and registers immediate runs for cancellation", async () => {
    let captured: (ProviderRequest & { policy?: Record<string, unknown> }) | undefined;
    let cancelled = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = createProviderExecutor({
      registry: createProviderRegistry([
        adapter(async (request) => {
          captured = request as typeof captured;
          return {
            session: Promise.resolve(session),
            events: (async function* () {
              await pending;
              yield {
                type: "session_ended",
                provider: "fake",
                occurredAt: new Date().toISOString(),
                provenance: { sessionId: "session-1" },
                payload: { status: "cancelled" },
              };
            })() as ProviderRun["events"],
            cancel: async () => {
              cancelled = true;
              release();
            },
          };
        }),
      ]),
    });
    const running = executor.execute(
      context({
        policy: {
          tools: { allow: ["read"], deny: ["write"], network: "disabled" },
          workspace: { writableRoots: ["/tmp/work"] },
          approval: { requiredBefore: ["agent"] },
          sandbox: "workspace-write",
          budget: {
            maxTurns: 2,
            maxTokens: 100,
            maxCostUsd: 1,
            timeoutMs: 5000,
            maxOutputBytes: 1000,
          },
        },
      }),
    );
    for (let i = 0; i < 20 && !captured; i++) await Bun.sleep(1);
    await Bun.sleep(1);
    await executor.cancel?.("attempt-1");
    const result = await running;
    expect(cancelled).toBe(true);
    expect(captured?.policy).toMatchObject({
      tools: { allow: ["read"], deny: ["write"], network: "disabled" },
      workspace: { writableRoots: ["/tmp/work"] },
      approval: { requiredBefore: ["agent"] },
      sandbox: "workspace-write",
      budget: { maxTurns: 2, maxTokens: 100, maxCostUsd: 1, timeoutMs: 5000, maxOutputBytes: 1000 },
    });
    expect(result.status).toBe("cancelled");
  });
});
