import { realpath } from "node:fs/promises";
import { decodeBoundary } from "@loopy/contract";
import { within } from "../../../../packages/runtime/src/os/sandbox/paths";
import { captureSchema } from "./metrics/artifacts";
import { baselineEndpoints } from "./metrics/sampler";
import { CONCURRENCY } from "./plan";

const baselinePhases: readonly string[] = ["baseline", "baseline-small"];

export async function requireCurrentBaseline(path: string, batch: string, directory: string) {
  const canonical = await realpath(path);
  const evidence = await realpath(directory);

  if (canonical === evidence || !within(evidence, canonical)) {
    throw new Error("Architecture baseline must be saved under its selected evidence directory.");
  }

  const receipt = decodeBoundary(captureSchema)(await Bun.file(canonical).json());

  if (
    !baselinePhases.includes(receipt.phase) ||
    receipt.batch !== batch ||
    receipt.workloadControls.apiSlots !== CONCURRENCY ||
    receipt.workloadControls.runtimeAttempts !== CONCURRENCY ||
    receipt.samples.length === 0
  ) {
    throw new Error(
      `Baseline must be a non-empty ${baselinePhases.join(" or ")} capture for batch ${batch} with ${CONCURRENCY} API slots and runtime attempts.`,
    );
  }

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
          sample.parseMs !== null,
      )
      .map((sample) => sample.endpoint),
  );

  const missing = baselineEndpoints.filter((endpoint) => !successful.has(endpoint));

  if (missing.length > 0) {
    throw new Error(`Baseline lacks successful measurement coverage: ${missing.join(", ")}.`);
  }

  return receipt;
}
