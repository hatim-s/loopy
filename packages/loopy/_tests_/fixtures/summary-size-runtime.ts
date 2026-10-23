import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import type { SummarySizeRequest } from "./summary-size-workerd.js";

export async function summarySizeRuntime() {
  const parent = resolve(import.meta.dir, "../../../..", ".loopy/architecture-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "summary-size-"));

  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "summary-size-workerd.ts")],
    target: "browser",
    format: "esm",
    outdir: directory,
    naming: "[name].js",
  });

  if (!built.success) {
    throw new Error(built.logs.join("\n"));
  }

  const runtime = new Miniflare({
    modulesRoot: directory,
    name: "summary-size-tests",
    host: "127.0.0.1",
    port: 0,
    modules: true,
    scriptPath: join(directory, "summary-size-workerd.js"),
    compatibilityDate: "2026-07-30",
    durableObjects: { PROBES: { className: "SummarySizeProbe", useSQLite: true } },
    durableObjectsPersist: join(directory, "durable"),
    r2Buckets: ["BUCKET"],
    r2Persist: join(directory, "r2"),
  });

  await runtime.ready;

  return {
    directory,
    evict: (instance: string) =>
      runtime.unsafeEvictDurableObject("summary-size-tests", "SummarySizeProbe", {
        name: instance,
      }),
    probe: async (instance: string, input: SummarySizeRequest) => {
      const namespace = await runtime.getDurableObjectNamespace("PROBES");

      const response = await namespace
        .get(namespace.idFromName(instance))
        .fetch("http://probe/", { method: "POST", body: JSON.stringify(input) });

      const body: unknown = await response.json();

      return { status: response.status, body };
    },
    cleanup: async () => {
      try {
        await runtime.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
