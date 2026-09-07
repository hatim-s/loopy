import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { normalizeClaudeStream } from "../src/adapters/claude/stream.js";
import { normalizeCodexStream } from "../src/adapters/codex/stream.js";
import { normalizeOpenCodeJsonLines } from "../src/adapters/opencode/events.js";
import { importOpenCodeSession } from "../src/adapters/opencode/import.js";
import { normalizePiJsonLines } from "../src/adapters/pi/events.js";
import { createDefaultProviderRegistry } from "../src/registered.js";

describe("coding trace fidelity", () => {
  for (const provider of ["codex", "claude", "pi", "opencode"] as const) {
    test(`${provider} imports intent, native edits, paired commands and results`, async () => {
      const source = await readFile(
        new URL(`./fixtures/${provider}-coding.jsonl`, import.meta.url),
        "utf8",
      );
      const importer = createDefaultProviderRegistry().get(provider)?.historicalImports?.[0];
      expect(importer).toBeDefined();
      if (!importer) throw new Error("Missing importer");
      const events = [];
      for await (const event of importer.import(source)) events.push(event);
      expect(
        events.some(
          (event) =>
            event.type === "message" &&
            event.payload?.role === "user" &&
            String(event.payload.content).includes("supplied name"),
        ),
      ).toBe(true);
      const calls = events.filter((event) => event.type === "tool_call");
      expect(calls).toHaveLength(2);
      expect(JSON.stringify(calls[0]?.payload?.input)).toContain("greeting.ts");
      expect(calls[1]?.payload?.input).toEqual({ command: "bun test" });
      const results = events.filter((event) => event.type === "tool_result");
      expect(results).toHaveLength(2);
      expect(calls.map((event) => event.payload?.toolCallId)).toEqual(
        results.map((event) => event.payload?.toolCallId),
      );
      expect(JSON.stringify(results[1]?.payload?.output)).toContain("1 pass");
      expect(
        events.some(
          (event) => event.type === "session_ended" && event.payload?.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        events
          .filter((event) => event.type !== "unknown")
          .every((event) => event.provenance.sessionId === "coding-session"),
      ).toBe(true);
    });
  }
  test("Codex rollout envelopes retain function arguments and match outputs", () => {
    const events = normalizeCodexStream([
      JSON.stringify({ type: "session_meta", payload: { id: "native-session" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: '{"cmd":"bun test"}',
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "1 pass" },
      }),
    ]);
    expect(events[1]?.input).toEqual({ cmd: "bun test" });
    expect(events[1]?.toolCallId).toBe(events[2]?.toolCallId);
    expect(events[2]?.sessionId).toBe("native-session");
  });
  test("tool failures stay tool results and do not invent a denied permission", async () => {
    const pi = await normalizePiJsonLines([
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        result: "failed",
        isError: true,
      }),
    ]);
    expect(pi.events[0]?.type).toBe("tool.completed");
    expect(pi.events.find((event) => event.type === "tool.completed")?.payload.isError).toBe(true);
    const oc = await normalizeOpenCodeJsonLines([
      JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool",
          callID: "c",
          tool: "bash",
          state: { input: { command: "bun test" }, status: "error", error: "failed" },
        },
      }),
    ]);
    expect(oc.events.find((event) => event.type === "tool.completed")?.payload.isError).toBe(true);
    const claude = normalizeClaudeStream([
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
    ]);
    expect(claude[0]?.result?.status).toBe("failed");
  });
  test("OpenCode official exports preserve user roles and completed tool inputs", async () => {
    const imported = await importOpenCodeSession(
      JSON.stringify({
        info: { id: "export-session" },
        messages: [
          {
            info: { role: "user", sessionID: "export-session" },
            parts: [{ type: "text", text: "Run tests" }],
          },
          {
            info: { role: "assistant", sessionID: "export-session" },
            parts: [
              {
                type: "tool",
                tool: "bash",
                callID: "test",
                state: { status: "completed", input: { command: "bun test" }, output: "pass" },
              },
              { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1 } },
            ],
          },
        ],
      }),
    );
    expect(imported.events.map((event) => event.type)).toEqual([
      "provider.message",
      "tool.requested",
      "tool.completed",
      "provider.usage",
      "provider.session_ended",
    ]);
    expect(imported.events[0]).toMatchObject({
      sessionId: "export-session",
      payload: { role: "user", content: "Run tests" },
    });
  });
  test("Codex emits one request for a started and completed command", () => {
    const item = { id: "command-1", type: "command_execution", command: "bun test" };
    const events = normalizeCodexStream([
      JSON.stringify({ type: "item.started", item }),
      JSON.stringify({
        type: "item.completed",
        item: { ...item, exit_code: 0, aggregated_output: "passed" },
      }),
    ]);
    expect(events.map((event) => event.kind)).toEqual(["tool", "tool_result"]);
    expect(events[1]?.metadata?.exitCode).toBe(0);
  });
});
