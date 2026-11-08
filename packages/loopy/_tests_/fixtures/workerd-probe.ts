import { basename, join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { Miniflare } from "miniflare";
import { bundleForBrowser } from "./bundle";
import { qualityTestRoot } from "./quality-test-root";

interface ProbeOptions {
  entry: string;
  name: string;
  className: string;
  r2?: "BUCKET";
}

export async function probeRuntime(options: ProbeOptions) {
  // Callers allocate in beforeAll, so the probe owns its scope and closes it in cleanup().
  const scope = Scope.makeUnsafe();
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const directory = qualityTestRoot(options.name, { scope });
  let runtime: Miniflare | undefined;

  try {
    await bundleForBrowser([options.entry], directory);

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
      await close();
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
        await close();
      }
    },
  };
}
