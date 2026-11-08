import { resolve } from "node:path";
import { probeRuntime } from "./workerd";

/** One workerd running the artifact registry probe, with its R2 bucket. */
export async function artifactRegistry(name: string) {
  const harness = await probeRuntime({
    entry: resolve(import.meta.dir, "artifact-registry-probe.ts"),
    name,
    className: "RegistryProbe",
    r2: "BUCKET",
  });

  return {
    bucket: () => harness.runtime.getR2Bucket("BUCKET"),
    cleanup: () => harness.cleanup(),
    call(workspace: string, operation: string, ...args: unknown[]) {
      // Bundle bytes cross into the probe as base64, as they do on the HTTP save route.
      const body: unknown = JSON.parse(
        JSON.stringify({ workspace, operation, args }, (key, value) =>
          key === "bytes" && value instanceof Uint8Array
            ? Buffer.from(value).toString("base64")
            : value,
        ),
      );

      return harness.probe("registry-test", { body });
    },
  };
}

export type ArtifactRegistry = Awaited<ReturnType<typeof artifactRegistry>>;
