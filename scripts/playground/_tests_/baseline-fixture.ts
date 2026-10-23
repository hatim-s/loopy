import { z } from "zod";
import { createMeasure } from "../metrics-request.js";
import type { Sample } from "../metrics-statistics.js";

export const expectedEndpoints = [
  "runs.latest",
  "loopies.counts",
  "runs.waiting",
  "runs.failed",
  "overview.counts",
  "logs.latest",
  "events.latest",
  "daemon",
  "runs.page2",
  "runs.slug",
  "logs.text",
  "events.run-filter",
  "logs.page2",
  "events.page2",
];

export async function baselineReceipt(failure: "none" | "transport" = "none") {
  const samples: Sample[] = [];

  const measure = createMeasure(async () => {
    if (failure === "transport") {
      throw new Error("Synthetic transport failure");
    }

    return Response.json({ ok: true });
  }, samples);

  for (const endpoint of expectedEndpoints) {
    await measure(endpoint, "/synthetic", z.object({ ok: z.literal(true) }));
  }

  return {
    scope: "local-playground-read-only-api",
    phase: "baseline-small",
    batch: "fresh-batch",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    elapsedMs: 100,
    targetRequestsPerSecond: 2,
    api: "http://127.0.0.1:15270",
    workspace: "playground",
    workloadControls: { apiSlots: 4, runtimeAttempts: 4 },
    samples,
  };
}
