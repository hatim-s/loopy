import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { sampleSchema } from "./metrics-statistics.js";

// Per-run detail requests are conditional and cannot be required before the first workload.
export const baselineEndpoints = [
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
] as const;

const baselineSchema = z.object({
  scope: z.literal("local-playground-read-only-api"),
  phase: z.enum(["baseline", "baseline-small"]),
  batch: z.string(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  elapsedMs: z.number().nonnegative(),
  targetRequestsPerSecond: z.number().min(1).max(3),
  api: z.url(),
  workspace: z.literal("playground"),
  workloadControls: z.object({ apiSlots: z.literal(4), runtimeAttempts: z.literal(4) }),
  samples: z.array(sampleSchema).min(1),
});

export async function requireCurrentBaseline(path: string, batch: string, directory: string) {
  const canonical = await realpath(path);

  if (!canonical.startsWith(`${await realpath(directory)}${sep}`)) {
    throw new Error("Architecture baseline must be saved under its selected evidence directory.");
  }

  const receipt = baselineSchema
    .extend({ batch: z.literal(batch) })
    .parse(await Bun.file(resolve(canonical)).json());

  const successful = new Set(
    receipt.samples
      .filter(
        (sample) =>
          sample.failure === null &&
          sample.status !== null &&
          sample.status >= 200 &&
          sample.status < 300 &&
          sample.bytes > 0 &&
          sample.headersMs !== null &&
          sample.headersMs >= 0 &&
          sample.totalMs >= 0 &&
          sample.parseMs !== null &&
          sample.parseMs >= 0 &&
          z.iso.datetime().safeParse(sample.at).success,
      )
      .map((sample) => sample.endpoint),
  );

  const missing = baselineEndpoints.filter((endpoint) => !successful.has(endpoint));

  if (missing.length > 0) {
    throw new Error(`Baseline lacks successful measurement coverage: ${missing.join(", ")}.`);
  }

  return receipt;
}
