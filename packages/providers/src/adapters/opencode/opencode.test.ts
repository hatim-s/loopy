import { describe, expect, test } from "vitest";
import {
  buildOpenCodeCapabilities,
  buildOpenCodeExportCommand,
  buildOpenCodeRunCommand,
  importOpenCodeSession,
  normalizeOpenCodeJsonLines,
  parseOpenCodeSessionList,
  parseOpenCodeVersion,
  probeOpenCode,
} from "./index.js";

const context = {
  runId: "00000000-0000-4000-8000-000000000001",
  nodeId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
};

describe("OpenCode adapter", () => {
  test("builds JSON run argv without shell interpolation or secrets", () => {
    expect(
      buildOpenCodeRunCommand({
        prompt: "echo $HOME; rm -rf /",
        model: "provider/model",
        dir: "/tmp/work",
      }),
    ).toEqual({
      executable: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--model",
        "provider/model",
        "--dir",
        "/tmp/work",
        "echo $HOME; rm -rf /",
      ],
    });
    expect(() => buildOpenCodeRunCommand({ prompt: "hello", auto: true })).toThrow(/allowAuto/);
    expect(() => buildOpenCodeRunCommand({ prompt: "hello", fork: true })).toThrow(/session/);
    expect(() => buildOpenCodeRunCommand({ prompt: "hello\nworld" })).toThrow(/unsafe/);
  });

  test("parses official version and honest capability degradation", () => {
    expect(parseOpenCodeVersion("opencode 0.1.2\n")).toBe("0.1.2");
    const capabilities = buildOpenCodeCapabilities("0.1.2");
    expect(capabilities.sessionFork).toBe(true);
    expect(capabilities.writablePathPolicy).toBe(false);
    expect(capabilities.networkPolicy).toBe(false);
  });

  test("normalizes visible messages, tools, usage and reasoning lossiness", async () => {
    const result = await normalizeOpenCodeJsonLines(
      [
        '{"type":"step_start","sessionID":"oc-1"}',
        '{"type":"text","sessionID":"oc-1","part":{"text":"hello"}}',
        '{"type":"tool_use","sessionID":"oc-1","part":{"tool":"bash","callID":"call-1","state":{"status":"completed","output":"ok"}}}',
        '{"type":"step_finish","sessionID":"oc-1","part":{"tokens":{"input":2,"output":3}}}',
        '{"type":"reasoning","sessionID":"oc-1","part":{"text":"secret thought"}}',
        '{"type":"text","sessionID":"oc-1","part":{"type":"reasoning","text":"secret part"}}',
        "not json",
      ],
      context,
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "provider.session_started",
      "provider.message",
      "tool.completed",
      "provider.usage",
    ]);
    expect(result.events[1]?.payload).toEqual({ role: "assistant", content: "hello" });
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "lossy_event",
      "lossy_event",
      "malformed_event",
    ]);
  });

  test("imports official export and parses session provenance", async () => {
    const imported = await importOpenCodeSession(
      { events: [{ type: "text", sessionID: "oc-export", part: { text: "exported" } }] },
      context,
    );
    expect(imported.schemaVersion).toBe("opencode.export.v1");
    expect(imported.sessionId).toBe("oc-export");
    expect(imported.sourceFormat).toBe("official-export");
    expect(parseOpenCodeSessionList('[{"id":"s1","title":"A"}]').sessions[0]?.id).toBe("s1");
    expect(buildOpenCodeExportCommand({ sessionId: "s1" }).args).toEqual(["export", "s1"]);
  });

  test("version-gates exports and preserves import provenance", async () => {
    const unsupported = await importOpenCodeSession(
      { schemaVersion: "opencode.export.v2", events: [] },
      { source: "fixture/export-v2.json", providerVersion: "0.1.2" },
    );
    expect(unsupported.events).toHaveLength(0);
    expect(unsupported.diagnostics[0]?.code).toBe("unsupported_version");
    expect(unsupported.provenance).toMatchObject({
      source: "fixture/export-v2.json",
      format: "opencode.export.v1",
      version: "0.1.2",
    });
  });

  test("degrades cleanly when OpenCode is unavailable", async () => {
    const probe = await probeOpenCode();
    expect(probe.installed).toBe(false);
    expect(probe.diagnostic).toMatch(/not found/);
  });
});
