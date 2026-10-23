import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Miniflare } from "miniflare";
import { routes } from "../src/contract/index.js";
import { revision } from "../src/core/index.js";
import { loopy, sh } from "../src/sdk/graph/index.js";
import { compiledBody } from "./compiled-fixture.js";
import { qualityTestRoot } from "./fixtures/quality-test-root.js";
import {
  type QueueProofDetails,
  type QueueProofEvent,
  readQueueProvider,
} from "./fixtures/workspace-read-queue-provider.js";

const token = "read-queue-synthetic-principal-0000001";

const controlToken = "read-queue-synthetic-control-0000002";

async function bounded<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  const timeout = new AbortController();

  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(`${label} exceeded ${ms} ms.`);
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

test("production Workspace queues runs, loopies and event history during provider lookup/start", async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const directory = await qualityTestRoot("read-queue");
  const events: QueueProofEvent[] = [];
  const origin = performance.now();

  const record = (event: string, details?: QueueProofDetails) => {
    events.push({ event, atMs: performance.now() - origin, details });
  };

  record("execution-start", { at: new Date().toISOString(), directory });
  console.log(`Read queue proof state: ${directory}`);

  try {
    const build = await Bun.build({
      entrypoints: [join(repository, "apps/cloud/src/worker.ts")],
      target: "browser",
      format: "esm",
      outdir: join(directory, "bundle"),
      naming: "[name].js",
    });

    expect(build.success).toBe(true);
    expect(build.logs).toEqual([]);
    record("production-bundle", {
      sha256: createHash("sha256")
        .update(await readFile(join(directory, "bundle/worker.js")))
        .digest("hex"),
    });

    for (const mode of ["lookup", "start"] as const) {
      const provider = readQueueProvider(mode, record);

      const runtime = new Miniflare({
        modulesRoot: join(directory, "bundle"),
        name: `read-queue-${mode}`,
        host: "127.0.0.1",
        port: 0,
        modules: true,
        scriptPath: join(directory, "bundle/worker.js"),
        compatibilityDate: "2026-07-30",
        durableObjects: { WORKSPACES: { className: "Workspace", useSQLite: true } },
        durableObjectsPersist: join(directory, mode, "do"),
        r2Buckets: { ARTIFACTS: `read-queue-${mode}` },
        r2Persist: join(directory, mode, "r2"),
        bindings: {
          LOOPY_STAGE: "local",
          LOCAL_AUTH: JSON.stringify([
            { token, workspace: mode },
            { token: controlToken, workspace: "control" },
          ]),
          CONCURRENCY: "1",
          SANDBOX_URL: provider.url,
          SANDBOX_TOKEN: "read-queue-synthetic-provider",
        },
      });

      const api = async (
        path: string,
        credential = token,
        options: { method?: string; body?: unknown } = {},
      ) => {
        const tenant = credential === token ? mode : "control";
        record("http-dispatch", { mode, tenant, path });

        const response = await runtime.dispatchFetch(`http://127.0.0.1/api${path}`, {
          method: options.method ?? "GET",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });

        record("http-headers", { mode, tenant, path, status: response.status });
        const body: unknown = await response.json();
        record("http-body", { mode, tenant, path, status: response.status });

        return { status: response.status, body };
      };

      try {
        await bounded(runtime.ready, "workerd startup", 10_000);
        const controlWarm = await api("/runs?limit=50", controlToken);
        expect(controlWarm.status).toBe(200);
        expect(routes.runs.response.parse(controlWarm.body)).toEqual([]);

        const body = await compiledBody("read-queue", "synthetic/read-queue.ts", {
          workspace: mode,
        });

        body.graph = loopy("read-queue", {
          input: {},
          run: () => sh(["synthetic-command-never-executed"]),
        }).graph;
        body.revision = await revision(body.graph);
        const saved = await api("/loopies/read-queue", token, { method: "PUT", body });
        expect(saved.status).toBe(200);
        routes.putLoopy.response.parse(saved.body);

        const started = await api("/loopies/read-queue/runs", token, {
          method: "POST",
          body: { input: {} },
        });

        expect(started.status).toBe(200);
        const run = routes.startRun.response.parse(started.body);
        await bounded(provider.entered, "provider hold entry", 5000);
        expect(provider.releaseReason).toBeNull();

        const heldFrom = events.length;
        const paths = ["/runs?limit=50", "/loopies", "/event-history?limit=50"] as const;
        const reads = paths.map((path) => api(path));
        const allReads = Promise.all(reads);
        // Observe early rejection immediately while retaining the original assertion failure.
        void allReads.catch(() => undefined);
        const control = await bounded(api(paths[0], controlToken), "control read", 1500);
        expect(control.status).toBe(200);
        expect(routes.runs.response.parse(control.body)).toEqual([]);
        await delay(200);
        expect(provider.releaseReason).toBeNull();
        expect(
          events
            .slice(heldFrom)
            .filter((event) => event.event === "http-headers" && event.details?.tenant === mode),
        ).toEqual([]);
        record("held-reads-pending", { mode, paths: [...paths], controlStatus: control.status });

        provider.release("manual");
        const [runs, loopies, history] = await bounded(allReads, "released reads", 5000);
        expect(runs?.status).toBe(200);
        expect(loopies?.status).toBe(200);
        expect(history?.status).toBe(200);
        expect(routes.runs.response.parse(runs?.body)).toMatchObject([
          { id: run.id, status: "succeeded" },
        ]);
        expect(routes.loopies.response.parse(loopies?.body)).toMatchObject([
          { slug: "read-queue" },
        ]);
        expect(routes.eventHistory.response.parse(history?.body).items.length).toBeGreaterThan(0);
        const snapshot = await api(`/runs/${run.id}`);
        expect(snapshot.status).toBe(200);
        expect(routes.run.response.parse(snapshot.body).run.status).toBe("succeeded");
        expect(provider.admissions).toHaveLength(1);
        expect(new Set(provider.admissions).size).toBe(1);
        expect(provider.lookups).toBe(1);
        expect(provider.errors).toEqual([]);
        expect(provider.releaseReason).toBe("manual");
        record("trial-passed", {
          mode,
          admissions: provider.admissions,
          lookups: provider.lookups,
        });
      } finally {
        provider.release("cleanup");

        try {
          await runtime.dispose();
        } finally {
          await provider.close();
          record("trial-resources-closed", { mode });
        }
      }
    }

    record("proof-passed");
  } catch (cause) {
    record("execution-end", { at: new Date().toISOString() });
    await writeFile(join(directory, "evidence.json"), `${JSON.stringify(events, null, 2)}\n`);
    console.error(`Read queue failure diagnostics retained at: ${directory}`);

    throw cause;
  }

  await rm(directory, { recursive: true, force: true });
}, 45_000);
