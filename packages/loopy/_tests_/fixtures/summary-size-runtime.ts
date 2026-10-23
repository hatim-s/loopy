import { resolve } from "node:path";
import type { SummarySizeRequest } from "./summary-size-workerd.js";
import { probeRuntime } from "./workerd-probe.js";

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
