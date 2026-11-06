import { expect, test } from "bun:test";
import { decodeRuntimeQueue } from "../../../dev/playground/runtime-queue-schema";

test("receipt inventory accepts the exact full producer queue format", () => {
  const line = JSON.stringify({
    executionKey: { runId: "fixture", nodeId: "0:code", scope: [] },
    attempt: 1,
    queuedAt: "2026-11-05T00:00:00.000Z",
    acquiredAt: "2026-11-05T00:00:00.001Z",
    finishedAt: "2026-11-05T00:00:00.002Z",
    queueWaitMs: 1,
    backendDurationMs: 1,
    outcome: "succeeded",
  });

  const record = decodeRuntimeQueue(JSON.parse(line));
  expect(record.executionKey.runId).toBe("fixture");
  expect(record.outcome).toBe("succeeded");
});
