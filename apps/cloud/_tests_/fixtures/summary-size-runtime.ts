import { resolve } from "node:path";
import { probeRuntime } from "../../../../packages/loopy/_tests_/fixtures/workerd-probe";
import type { SummarySizeRequest } from "./summary-size-workerd";

export async function summarySizeRuntime() {
  const harness = await probeRuntime({
    entry: resolve(import.meta.dir, "summary-size-workerd.ts"),
    name: "summary-size-tests",
    className: "SummarySizeProbe",
    r2: "BUCKET",
  });

  return {
    ...harness,
    probe: (instance: string, input: SummarySizeRequest) =>
      harness.probe(instance, { body: input }),
  };
}
