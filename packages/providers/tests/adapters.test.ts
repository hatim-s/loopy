import { describe, expect, test } from "bun:test";
import {
  buildClaudeCapabilities,
  buildClaudeCommand,
  createClaudeCancellationMetadata,
  importClaudeHistory,
  normalizeClaudeStream,
  parseClaudeVersion,
  probeClaude,
} from "../src/adapters/claude/index.js";
import {
  buildCodexCapabilities,
  buildCodexCommand,
  buildCodexInstallation,
  createCodexCancellationMetadata,
  importCodexHistory,
  normalizeCodexStream,
  parseCodexVersion,
  probeCodex,
} from "../src/adapters/codex/index.js";

describe("Codex adapter", () => {
  test("builds argv without shell interpolation or bypass flags", () => {
    const command = buildCodexCommand({
      prompt: "$(touch /tmp/nope); --danger",
      model: "model;rm",
      cwd: "/tmp/a b",
      sandbox: "read-only",
      outputSchema: { type: "object" },
      resumeSessionId: "session-1",
    });
    expect(command.executable).toBe("codex");
    expect(command.args).toContain("--json");
    expect(command.args).toContain("--sandbox");
    expect(command.args).not.toContain("--danger-full-access");
    expect(command.args).not.toContain("--full-auto");
    expect(command.args).toContain("$(touch /tmp/nope); --danger");
  });

  test("normalizes visible events, usage, session IDs, and bounded unknown diagnostics", () => {
    const events = normalizeCodexStream(
      [
        JSON.stringify({ type: "thread.started", thread_id: "s1" }),
        JSON.stringify({
          type: "item.completed",
          thread_id: "s1",
          item: { id: "m1", type: "agent_message", text: "visible" },
        }),
        JSON.stringify({
          type: "item.started",
          thread_id: "s1",
          item: { id: "t1", type: "command_execution", command: "echo safe" },
        }),
        JSON.stringify({
          type: "item.completed",
          thread_id: "s1",
          item: { id: "t1", type: "command_execution", aggregated_output: "safe", exit_code: 0 },
        }),
        JSON.stringify({
          type: "turn.completed",
          thread_id: "s1",
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
        JSON.stringify({ type: "unknown.future", payload: "x".repeat(100) }),
        "not-json",
      ],
      { maxDiagnosticBytes: 40 },
    );
    expect(events.some((event) => event.kind === "assistant" && event.text === "visible")).toBe(
      true,
    );
    expect(events.some((event) => event.kind === "tool" && event.toolCallId === "t1")).toBe(true);
    expect(events.some((event) => event.kind === "tool_result")).toBe(true);
    expect(events.some((event) => event.kind === "usage" && event.usage?.totalTokens === 5)).toBe(
      true,
    );
    expect(
      events
        .filter((event) => event.kind === "diagnostic")
        .every((event) => (event.diagnostic?.raw?.length ?? 0) <= 40),
    ).toBe(true);
  });

  test("parses version and reports unavailable installs without assuming live provider access", async () => {
    expect(parseCodexVersion("codex-cli 0.146.0")).toBe("0.146.0");
    const installation = await probeCodex(
      async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
      { detectedAt: "2026-08-17T00:00:00.000Z" },
    );
    expect(installation.installation.installed).toBe(false);
    expect(installation.installation.diagnostic).toContain("unavailable");
    expect(
      buildCodexInstallation({
        installed: true,
        version: "0.146.0",
        detectedAt: "2026-08-17T00:00:00.000Z",
      }).capabilities.provider,
    ).toBe("codex");
    expect(buildCodexCapabilities().nativeSandbox).toBe(true);
  });

  test("marks history imports unstable and preserves provenance", () => {
    const imported = importCodexHistory('{"type":"thread.started","thread_id":"s1"}\n', {
      source: "fixture/codex-cli-0.146.0",
      providerVersion: "0.146.0",
      importedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(imported.unstable).toBe(true);
    expect(imported.formatVersion).toBe("codex-cli-0.146.0");
    expect(imported.provenance.source).toContain("fixture");
  });

  test("exposes explicit cancellation metadata", () => {
    expect(createCodexCancellationMetadata("user", 10)).toMatchObject({
      provider: "codex",
      signal: "SIGTERM",
      escalationSignal: "SIGKILL",
      gracePeriodMs: 10,
    });
  });
});

describe("Claude adapter", () => {
  test("builds documented stream-json argv and maps permission/tool controls", () => {
    const command = buildClaudeCommand({
      prompt: "$(touch /tmp/nope); --danger",
      model: "sonnet;rm",
      maxTurns: 4,
      maxBudgetUsd: 1.5,
      tools: ["Bash", "Read"],
      allowedTools: ["Bash(echo *)"],
      disallowedTools: ["WebFetch"],
      permissionMode: "plan",
      sessionId: "s1",
      resumeSessionId: "s0",
      forwardSubagentText: true,
    });
    expect(command.args.slice(0, 5)).toEqual([
      "-p",
      "$(touch /tmp/nope); --danger",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(command.args).toContain("--allowedTools");
    expect(command.args).toContain("--disallowedTools");
    expect(command.args).toContain("--forward-subagent-text");
    expect(command.args).not.toContain("--dangerously-skip-permissions");
    expect(command.args).not.toContain("bypassPermissions");
  });

  test("normalizes assistant, tool, tool result, usage, result, and redacted reasoning safely", () => {
    const events = normalizeClaudeStream(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
        JSON.stringify({
          type: "assistant",
          session_id: "s1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "visible" },
              { type: "thinking", thinking: "secret" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo safe" } },
            ],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        }),
        JSON.stringify({
          type: "tool_result",
          session_id: "s1",
          tool_use_id: "t1",
          content: "safe",
          is_error: false,
        }),
        JSON.stringify({
          type: "result",
          session_id: "s1",
          subtype: "success",
          result: "done",
          total_cost_usd: 0.01,
        }),
        JSON.stringify({ type: "future.event", payload: "x".repeat(100) }),
        "not-json",
      ],
      { maxDiagnosticBytes: 40 },
    );
    expect(events.some((event) => event.kind === "assistant" && event.text === "visible")).toBe(
      true,
    );
    expect(events.some((event) => event.kind === "tool" && event.toolCallId === "t1")).toBe(true);
    expect(events.some((event) => event.kind === "tool_result" && event.toolCallId === "t1")).toBe(
      true,
    );
    expect(events.some((event) => event.kind === "usage" && event.usage?.inputTokens === 4)).toBe(
      true,
    );
    expect(
      events.some((event) => event.kind === "result" && event.result?.status === "succeeded"),
    ).toBe(true);
    expect(events.some((event) => event.kind === "usage" && event.usage?.costUsd === 0.01)).toBe(
      true,
    );
    expect(
      events
        .filter((event) => event.kind === "diagnostic")
        .every((event) => (event.diagnostic?.raw?.length ?? 0) <= 40),
    ).toBe(true);
  });

  test("reports the documented absent-local installation shape and capability degradation", async () => {
    expect(parseClaudeVersion("Claude Code 1.2.3")).toBe("1.2.3");
    const installation = await probeClaude(
      async () => ({ exitCode: 127, stdout: "", stderr: "claude: command not found" }),
      { detectedAt: "2026-08-17T00:00:00.000Z" },
    );
    expect(installation.installed).toBe(false);
    expect(installation.diagnostic).toContain("unavailable");
    expect(buildClaudeCapabilities({ forwardSubagentText: false }).nestedSubagentVisibility).toBe(
      false,
    );
  });

  test("marks history imports versioned, unstable, and provenance-bearing", () => {
    const imported = importClaudeHistory('{"type":"system","subtype":"init","session_id":"s1"}\n', {
      source: "fixture/claude-code-stream-json-1.0.0",
      providerVersion: "1.0.0",
      importedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(imported.unstable).toBe(true);
    expect(imported.formatVersion).toBe("claude-code-1.0.0");
    expect(imported.provenance.providerVersion).toBe("1.0.0");
  });

  test("exposes explicit cancellation metadata", () => {
    expect(createClaudeCancellationMetadata("user", 10)).toMatchObject({
      provider: "claude",
      signal: "SIGTERM",
      escalationSignal: "SIGKILL",
      gracePeriodMs: 10,
    });
  });
});
