import { basename, join, resolve } from "node:path";
import { Effect, Exit, Schema, Scope } from "effect";
import { Miniflare, type MiniflareOptions, type WorkerOptions } from "miniflare";
import { bundleForBrowser } from "../../../../packages/runtime/_tests_/fixtures/bundle";
import { qualityTestRoot } from "../../../../packages/runtime/_tests_/fixtures/quality-test-root";

const wranglerSchema = Schema.Struct({
  compatibility_date: Schema.String,
  compatibility_flags: Schema.optionalKey(Schema.Array(Schema.String)),
  durable_objects: Schema.Struct({
    bindings: Schema.Array(Schema.Struct({ name: Schema.String, class_name: Schema.String })),
  }),
  r2_buckets: Schema.Array(Schema.Struct({ binding: Schema.String, bucket_name: Schema.String })),
  vars: Schema.Record(Schema.String, Schema.String),
});

// Tests boot the Worker with the deployed compatibility settings and bindings, not a copy of them.
const wrangler = Schema.decodeUnknownSync(wranglerSchema)(
  Bun.JSONC.parse(await Bun.file(resolve(import.meta.dir, "../../wrangler.jsonc")).text()),
);

/** A module Worker on the deployed compatibility date and flags. */
export function testWorker(options: WorkerOptions): WorkerOptions {
  return {
    modules: true,
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags && [...wrangler.compatibility_flags],
    ...options,
  };
}

/** The deployed vars with the test's values on top. */
export function cloudBindings(bindings: Record<string, string>) {
  return { ...wrangler.vars, ...bindings };
}

/** The bucket a binding names, so a probe Worker can share the cloud Worker's bucket. */
export function cloudBucket(binding: string) {
  const bucket = wrangler.r2_buckets.find((entry) => entry.binding === binding);

  if (!bucket) {
    throw new Error(`apps/cloud/wrangler.jsonc declares no R2 binding named ${binding}.`);
  }

  return bucket.bucket_name;
}

/** The production Worker bundled into `bundle`, with every binding wrangler.jsonc declares. */
export function cloudWorker(bundle: string, bindings: Record<string, string>) {
  return testWorker({
    name: "cloud",
    scriptPath: resolve(bundle, "worker.js"),
    durableObjects: Object.fromEntries(
      wrangler.durable_objects.bindings.map((entry) => [
        entry.name,
        { className: entry.class_name, useSQLite: true },
      ]),
    ),
    r2Buckets: Object.fromEntries(
      wrangler.r2_buckets.map((entry) => [entry.binding, entry.bucket_name]),
    ),
    bindings: cloudBindings(bindings),
  });
}

/** Starts workerd on an ephemeral loopback port and disposes it when startup fails. */
export async function startWorkerd(options: MiniflareOptions) {
  const runtime = new Miniflare({ host: "127.0.0.1", port: 0, ...options });

  try {
    await runtime.ready;
  } catch (cause) {
    await runtime.dispose();

    throw cause;
  }

  return runtime;
}

interface ProbeOptions {
  entry: string;
  name: string;
  className: string;
  r2?: "BUCKET";
}

/** Bundles one probe entry and serves its Durable Object class under the PROBES binding. */
export async function probeRuntime(options: ProbeOptions) {
  // Callers allocate in beforeAll, so the probe owns its scope and closes it in cleanup().
  const scope = Scope.makeUnsafe();
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const directory = qualityTestRoot(options.name, { scope });
  let runtime: Miniflare;

  try {
    await bundleForBrowser([options.entry], directory);

    runtime = await startWorkerd({
      modulesRoot: directory,
      durableObjectsPersist: join(directory, "durable"),
      r2Persist: options.r2 ? join(directory, "r2") : undefined,
      ...testWorker({
        name: options.name,
        scriptPath: join(directory, `${basename(options.entry, ".ts")}.js`),
        durableObjects: { PROBES: { className: options.className, useSQLite: true } },
        r2Buckets: options.r2 ? [options.r2] : undefined,
      }),
    });
  } catch (cause) {
    await close();

    throw cause;
  }

  const ready = runtime;

  return {
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
