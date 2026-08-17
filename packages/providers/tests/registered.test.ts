import { describe, expect, test } from "bun:test";
import { createCodexProviderAdapter, createDefaultProviderRegistry } from "../src/index.js";

const codexCommandProbe = [
  "const args = process.argv.slice(1);",
  "if (args[0] !== 'exec' || !args.includes('--json') || !args.includes('--model') || !args.includes('gpt-5.6-luna')) process.exit(2);",
  "for (const row of [{ type: 'thread.started', thread_id: 'probe-session' }, { type: 'item.completed', thread_id: 'probe-session', item: { type: 'agent_message', text: 'probe-ok' } }, { type: 'thread.completed', thread_id: 'probe-session', status: 'succeeded' }]) console.log(JSON.stringify(row));",
].join(" ");

const codexRequest = (network: "disabled" | "restricted" | "unrestricted") => ({
  runId: "run-1",
  attemptId: "attempt-1",
  nodeId: "node-1",
  input: {},
  prompt: "probe",
  model: "gpt-5.6-luna",
  policy: { tools: { network } },
});

describe("registered providers", () => {
  test("allows unrestricted Codex runs to build and execute their command", async () => {
    const adapter = createCodexProviderAdapter({
      executable: process.execPath,
      commandPrefixArgs: ["-e", codexCommandProbe],
    });
    const run = await adapter.start(codexRequest("unrestricted"));
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "session_started",
      "message",
      "session_ended",
    ]);
  });

  for (const network of ["disabled", "restricted"] as const) {
    test(`fails closed for Codex ${network} network policy`, async () => {
      const adapter = createCodexProviderAdapter();
      await expect(adapter.start(codexRequest(network))).rejects.toThrow(
        "Codex cannot enforce network policy.",
      );
    });
  }

  test("registers exactly the four supported provider IDs", () => {
    expect(
      createDefaultProviderRegistry()
        .all()
        .map((adapter) => adapter.id),
    ).toEqual(["codex", "claude", "opencode", "pi"]);
  });

  test.skipIf(process.env.LOOPY_LIVE_PROVIDER_PROBES !== "1")(
    "opt-in live probes record the machine's installed provider versions",
    async () => {
      const result = await Promise.all(
        createDefaultProviderRegistry()
          .all()
          .map((adapter) => adapter.probe()),
      );
      expect(result.map((probe) => probe.provider)).toEqual(["codex", "claude", "opencode", "pi"]);
      for (const probe of result) {
        expect(probe.capabilities.schemaVersion).toBe("1");
        if (probe.available) {
          expect(probe.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
        } else {
          expect(probe.version).toBeUndefined();
          expect(probe.diagnostic).toBeTruthy();
        }
      }
    },
  );
});
