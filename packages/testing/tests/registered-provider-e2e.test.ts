import { describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "@loopy/providers";
import { createProviderExecutor, RuntimeScheduler } from "@loopy/runtime";
import { InMemoryRuntimeStore } from "../src/index.ts";

// This shim never calls a vendor service. It emits deterministic lifecycle and
// message records based only on the provider-shaped argv it receives.
const shim = new URL("../fixtures/provider-shim.mjs", import.meta.url).pathname;

describe("registered provider adapter conformance", () => {
  test("runs the same two-agent workflow through every registered adapter into canonical traces", async () => {
    const ids = ["codex", "claude", "opencode", "pi"] as const;
    const shapes: string[][] = [];
    for (const provider of ids) {
      const registry = createDefaultProviderRegistry({
        [provider]: {
          executable: process.execPath,
          commandPrefixArgs: [shim],
          cwd: process.cwd(),
        },
      });
      const stored: Array<{ sequence: number; provider: string; type: string; payload?: unknown }> =
        [];
      const executor = createProviderExecutor({
        registry,
        onEvent: (event) => {
          stored.push({
            sequence: stored.length,
            provider: event.provider,
            type: event.type,
            payload: event.payload,
          });
        },
      });
      const runtime = new RuntimeScheduler({
        store: new InMemoryRuntimeStore(),
        provider: executor,
        id: (() => {
          let index = 0;
          return () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
        })(),
      });
      const result = await runtime.run({
        id: `workflow-${provider}`,
        workflowVersion: 1,
        nodes: [
          { id: "agent-a", kind: "agent", provider, prompt: "first" },
          { id: "agent-b", kind: "agent", provider, prompt: "second" },
        ],
        edges: [{ id: "edge", source: "agent-a", target: "agent-b" }],
      });
      expect(result.run.status).toBe("succeeded");
      expect(result.attempts.filter((attempt) => attempt.status === "succeeded")).toHaveLength(2);
      expect(stored.map((event) => event.provider)).toEqual([
        provider,
        provider,
        provider,
        provider,
        provider,
        provider,
      ]);
      expect(stored.filter((event) => event.type === "message")).toHaveLength(2);
      shapes.push(stored.map((event) => event.type));
    }
    expect(shapes.every((shape) => JSON.stringify(shape) === JSON.stringify(shapes[0]))).toBe(true);
    expect(shapes[0]).toEqual([
      "session_started",
      "message",
      "session_ended",
      "session_started",
      "message",
      "session_ended",
    ]);
  });
});
