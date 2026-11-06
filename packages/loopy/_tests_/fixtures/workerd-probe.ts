import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Miniflare } from "miniflare";
import { qualityTestRoot } from "./quality-test-root";

interface ProbeOptions {
  entry: string;
  name: string;
  className: string;
  r2?: "BUCKET";
}

export async function probeRuntime(options: ProbeOptions) {
  const directory = await qualityTestRoot(options.name);
  let runtime: Miniflare | undefined;

  try {
    const built = await Bun.build({
      entrypoints: [options.entry],
      target: "browser",
      format: "esm",
      outdir: directory,
      naming: "[name].js",
    });

    if (!built.success || built.logs.length > 0) {
      throw new Error(`Workerd probe build failed: ${built.logs.join("\n")}`);
    }

    runtime = new Miniflare({
      modulesRoot: directory,
      name: options.name,
      host: "127.0.0.1",
      port: 0,
      modules: true,
      scriptPath: join(directory, `${basename(options.entry, ".ts")}.js`),
      compatibilityDate: "2026-07-30",
      durableObjects: { PROBES: { className: options.className, useSQLite: true } },
      durableObjectsPersist: join(directory, "durable"),
      r2Buckets: options.r2 ? [options.r2] : undefined,
      r2Persist: options.r2 ? join(directory, "r2") : undefined,
    });
    await runtime.ready;
  } catch (cause) {
    try {
      await runtime?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    throw cause;
  }

  const ready = runtime;

  return {
    directory,
    runtime: ready,
    evict: (instance: string) =>
      ready.unsafeEvictDurableObject(options.name, options.className, { name: instance }),
    async probe(instance: string, request: { path?: string; body?: unknown } = {}) {
      const namespace = await ready.getDurableObjectNamespace("PROBES");

      const response = await namespace
        .get(namespace.idFromName(instance))
        .fetch(`http://probe${request.path ?? "/"}`, {
          method: request.body === undefined ? "GET" : "POST",
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });

      const body: unknown = await response.json();

      return { status: response.status, body };
    },
    async cleanup() {
      try {
        await ready.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
