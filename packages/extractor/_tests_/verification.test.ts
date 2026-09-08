import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { TraceEventSchema } from "@loopy/contracts";
import { segmentTrace } from "../src/segmentation.ts";
import { includeToolVerification } from "../src/verification.ts";

test("native explicit tool success grounds a check without inventing exit code", () => {
  for (const status of [false, true, undefined]) {
    const identity = {
      schemaVersion: "1",
      runId: randomUUID(),
      nodeId: randomUUID(),
      attemptId: randomUUID(),
      sessionId: "session",
      provider: "claude",
      toolCallId: randomUUID(),
      occurredAt: "2026-09-08T00:00:00.000Z",
      monotonicOffsetMs: 0,
    };
    const events = [
      TraceEventSchema.parse({
        ...identity,
        id: randomUUID(),
        sequence: 0,
        type: "tool.requested",
        payload: { tool: "Bash", input: { command: "bun test" } },
      }),
      TraceEventSchema.parse({
        ...identity,
        id: randomUUID(),
        sequence: 1,
        type: "tool.completed",
        payload: { output: "tool output" },
      }),
    ];
    const segmentation = segmentTrace({ events });
    const result = segmentation.events[1];
    if (!result || result.type !== "tool.completed") throw new Error("Missing tool result");
    // The parser change lands independently. Exercise the canonical field at the extraction boundary.
    if (status !== undefined) Object.assign(result.payload, { isError: status });
    includeToolVerification(segmentation);
    expect(segmentation.verification).toHaveLength(status === false ? 1 : 0);
    expect(result.payload.exitCode).toBeUndefined();
    if (status === false)
      expect(segmentation.evidence.at(-1)?.summary).toContain("did not record a numeric exit code");
  }
});
