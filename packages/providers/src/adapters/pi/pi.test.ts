import { describe, expect, test } from "vitest";
import {
  buildPiCapabilities,
  buildPiRunCommand,
  importPiSession,
  normalizePiJsonLines,
  parsePiVersion,
  probePi,
} from "./index.js";

const context = {
  runId: "00000000-0000-4000-8000-000000000011",
  nodeId: "00000000-0000-4000-8000-000000000012",
  attemptId: "00000000-0000-4000-8000-000000000013",
};

describe("Pi adapter", () => {
  test("maps explicit tools and safe defaults to Pi argv", () => {
    expect(
      buildPiRunCommand({
        prompt: "inspect $HOME",
        provider: "provider",
        model: "model",
        thinking: "high",
        sessionId: "session",
        sessionDir: "/tmp/sessions",
        tools: ["read", "bash"],
        excludeTools: ["browser"],
        noExtensions: true,
      }),
    ).toEqual({
      executable: "pi",
      args: [
        "--print",
        "--mode",
        "json",
        "--provider",
        "provider",
        "--model",
        "model",
        "--thinking",
        "high",
        "--session-id",
        "session",
        "--session-dir",
        "/tmp/sessions",
        "--tools",
        "read,bash",
        "--exclude-tools",
        "browser",
        "--no-extensions",
        "--no-approve",
        "inspect $HOME",
      ],
    });
    expect(buildPiRunCommand({ prompt: "hello", approval: "approve" }).args).toContain("--approve");
    expect(buildPiRunCommand({ prompt: "hello", sessionId: "s" }).args).toContain("--session-id");
    expect(() => buildPiRunCommand({ prompt: "hello", tools: ["a,b"] })).toThrow(/commas/);
  });

  test("reports Pi capabilities separately from unsupported path controls", () => {
    expect(parsePiVersion("pi v0.80.6")).toBe("0.80.6");
    const capabilities = buildPiCapabilities("0.80.6");
    expect(capabilities.explicitReasoningLevel).toBe(true);
    expect(capabilities.toolAllowlist).toBe(true);
    expect(capabilities.sessionFork).toBe(false);
    expect(capabilities.writablePathPolicy).toBe(false);
  });

  test("normalizes Pi JSON events and omits hidden reasoning", async () => {
    const result = await normalizePiJsonLines(
      [
        '{"type":"session","version":3,"id":"pi-1"}',
        '{"type":"message_start","sessionId":"pi-1","message":{"role":"user","content":"hello"}}',
        '{"type":"message_update","sessionId":"pi-1","assistantMessageEvent":{"type":"thinking_delta","delta":"private"}}',
        '{"type":"message_end","sessionId":"pi-1","message":{"role":"assistant","content":[{"type":"thinking","text":"private"},{"type":"text","text":"visible"}]}}',
        '{"type":"tool_execution_start","sessionId":"pi-1","toolCallId":"call-1","toolName":"bash","args":{"command":"pwd"}}',
        '{"type":"tool_execution_end","sessionId":"pi-1","toolCallId":"call-1","toolName":"bash","result":"/tmp","isError":false}',
        '{"type":"turn_end","sessionId":"pi-1","usage":{"input":2,"output":4}}',
        '{"type":"agent_end","sessionId":"pi-1"}',
        '{"type":"future_event","sessionId":"pi-1"}',
      ],
      context,
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "provider.session_started",
      "provider.message",
      "provider.message",
      "tool.requested",
      "tool.completed",
      "provider.usage",
      "provider.session_ended",
    ]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["lossy_event", "unknown_event"]);
  });

  test("imports only known versioned session JSONL and warns on future versions", async () => {
    const imported = await importPiSession(
      '{"type":"session","version":3,"id":"pi-import"}\n{"type":"agent_end","sessionId":"pi-import"}',
      context,
    );
    expect(imported.schemaVersion).toBe("pi.session.v3");
    expect(imported.sessionFileVersion).toBe(3);
    const future = await importPiSession(
      '{"type":"session","version":99,"id":"pi-future"}',
      context,
    );
    expect(future.diagnostics[0]?.code).toBe("unsupported_version");
  });

  test("degrades cleanly when Pi is unavailable", async () => {
    const probe = await probePi();
    expect(probe.installed).toBe(false);
    expect(probe.diagnostic).toMatch(/not found/);
  });
});
