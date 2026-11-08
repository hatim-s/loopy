import { routes } from "@loopy/contract";
import type { Capture } from "../../../dev/playground/metrics/artifacts";
import { createMeasure } from "../../../dev/playground/metrics/request";
import { baselineEndpoints } from "../../../dev/playground/metrics/sampler";
import { type Sample, summarize } from "../../../dev/playground/metrics/statistics";

export async function baselineReceipt(failure: "none" | "transport" = "none"): Promise<Capture> {
  const samples: Sample[] = [];

  const measure = createMeasure(async () => {
    if (failure === "transport") {
      throw new Error("Synthetic transport failure");
    }

    return Response.json({ cursor: 0, epoch: "synthetic" });
  }, samples);

  for (const endpoint of baselineEndpoints) {
    await measure(endpoint, routes.cursor, {});
  }

  return {
    scope: "local-playground-read-only-api",
    phase: "baseline-small",
    batch: "fresh-batch",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    elapsedMs: 100,
    targetRequestsPerSecond: 2,
    samples,
    summaries: summarize(samples),
    resources: [],
    limits: [],
    api: "http://127.0.0.1:15270",
    dashboard: "http://127.0.0.1:15272",
    workspace: "playground",
    workloadControls: { apiSlots: 4, runtimeAttempts: 4 },
  };
}
