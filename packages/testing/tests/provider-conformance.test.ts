import { capabilityReport, type ProviderEvent } from "@loopy/providers";
import { describe, expect, it } from "vitest";
import { createFakeProviderAdapter, runProviderConformance } from "../src/provider-conformance";

describe("provider conformance", () => {
  it("checks provenance and normalized events", async () => {
    const event: ProviderEvent = {
      type: "message",
      provider: "fake",
      occurredAt: new Date(0).toISOString(),
      provenance: {},
      payload: { text: "hello" },
    };
    const result = await runProviderConformance(
      createFakeProviderAdapter({
        capabilityReport: capabilityReport({
          structuredStreamingEvents: { status: "supported" },
          sessionResume: { status: "degraded", reason: "fixture has no persisted state" },
        }),
        events: [event],
      }),
      { exercise: { runId: "run", attemptId: "attempt", nodeId: "node", input: {} } },
    );
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.name)).toContain("event provenance");
  });

  it("rejects degradation without an explanation", async () => {
    const result = await runProviderConformance(
      createFakeProviderAdapter({
        capabilityReport: {
          schemaVersion: "1",
          capabilities: { sessionResume: { status: "degraded" } },
          supported: [],
          degraded: ["sessionResume"],
          unavailable: [],
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "honest capability report")?.passed).toBe(
      false,
    );
  });
});
