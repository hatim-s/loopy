import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { decodeBoundary, routes } from "@loopy/contract";
import { revision } from "@loopy/core";
import { loopy, sh } from "@loopy/sdk";
import { compiledBody } from "../../../packages/runtime/_tests_/fixtures/compiled";
import { qualityTestRoot } from "../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { fileScope } from "../../../packages/runtime/_tests_/fixtures/test-scope";
import { bounded } from "../../../packages/runtime/_tests_/fixtures/wait";
import { cloudWorker, cloudWorkerBundle, startWorkerd } from "./fixtures/workerd";
import { readQueueProvider } from "./fixtures/workspace-read-queue-provider";

const token = "read-queue-synthetic-principal-0000001";

const controlToken = "read-queue-synthetic-control-0000002";

const scope = fileScope();

let directory: string;

let bundle: string;

beforeAll(async () => {
  directory = qualityTestRoot("read-queue", { scope });
  bundle = await cloudWorkerBundle();
});

test("production Workspace queues runs, loopies and event history during provider lookup/start", async () => {
  for (const mode of ["lookup", "start"] as const) {
    const provider = readQueueProvider(mode);
    // Paths of the held tenant's reads whose response headers have arrived.
    const answered: string[] = [];

    const runtime = await startWorkerd({
      ...cloudWorker(bundle, {
        LOCAL_AUTH: JSON.stringify([
          { token, workspace: mode },
          { token: controlToken, workspace: "control" },
        ]),
        CONCURRENCY: "1",
        SANDBOX_URL: provider.url,
        SANDBOX_TOKEN: "read-queue-synthetic-provider",
      }),
      modulesRoot: bundle,
      name: `read-queue-${mode}`,
      durableObjectsPersist: join(directory, mode, "do"),
      r2Persist: join(directory, mode, "r2"),
    }).catch(async (cause: unknown) => {
      await provider.close();

      throw cause;
    });

    const api = async (
      path: string,
      credential = token,
      options: { method?: string; body?: unknown } = {},
    ) => {
      const response = await runtime.dispatchFetch(`http://127.0.0.1/api${path}`, {
        method: options.method ?? "GET",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (credential === token) {
        answered.push(path);
      }

      const body: unknown = await response.json();

      return { status: response.status, body };
    };

    try {
      const controlWarm = await api("/runs?limit=50", controlToken);
      expect(controlWarm.status).toBe(200);
      expect(decodeBoundary(routes.runs.response)(controlWarm.body).runs).toEqual([]);

      const body = await compiledBody("read-queue", "synthetic/read-queue.ts", {
        workspace: mode,
      });

      body.graph = loopy("read-queue", {
        input: {},
        run: () => sh(["synthetic-command-never-executed"]),
      });
      body.revision = await revision(body.graph);
      const saved = await api("/loopies/read-queue", token, { method: "PUT", body });
      expect(saved.status).toBe(200);
      decodeBoundary(routes.putLoopy.response)(saved.body);

      const started = await api("/loopies/read-queue/runs", token, {
        method: "POST",
        body: { input: {} },
      });

      expect(started.status).toBe(200);
      const run = decodeBoundary(routes.startRun.response)(started.body);
      await bounded(provider.entered, "provider hold entry", 5000);
      expect(provider.releaseReason).toBeNull();

      const answeredBefore = answered.length;
      const paths = ["/runs?limit=50", "/loopies", "/event-history?limit=50"] as const;
      const reads = paths.map((path) => api(path));
      const allReads = Promise.all(reads);
      // Observe early rejection immediately while retaining the original assertion failure.
      void allReads.catch(() => undefined);
      const control = await api(paths[0], controlToken);
      expect(control.status).toBe(200);
      expect(decodeBoundary(routes.runs.response)(control.body).runs).toEqual([]);
      // The control read was sent after the held reads and has answered, so a held read that
      // bypassed the queue would have answered too.
      expect(provider.releaseReason).toBeNull();
      expect(answered.slice(answeredBefore)).toEqual([]);

      provider.release("manual");
      const [runs, loopies, history] = await bounded(allReads, "released reads", 5000);
      expect(runs?.status).toBe(200);
      expect(loopies?.status).toBe(200);
      expect(history?.status).toBe(200);
      expect(decodeBoundary(routes.runs.response)(runs?.body).runs).toMatchObject([
        { id: run.id, status: "succeeded" },
      ]);
      expect(decodeBoundary(routes.loopies.response)(loopies?.body)).toMatchObject([
        { slug: "read-queue" },
      ]);
      expect(
        decodeBoundary(routes.eventHistory.response)(history?.body).items.length,
      ).toBeGreaterThan(0);
      const snapshot = await api(`/runs/${run.id}`);
      expect(snapshot.status).toBe(200);
      expect(decodeBoundary(routes.run.response)(snapshot.body).run.status).toBe("succeeded");
      expect(provider.admissions).toHaveLength(1);
      expect(new Set(provider.admissions).size).toBe(1);
      expect(provider.lookups).toBe(1);
      expect(provider.errors).toEqual([]);
      expect(provider.releaseReason).toBe("manual");
    } finally {
      provider.release("cleanup");

      try {
        await runtime.dispose();
      } finally {
        await provider.close();
      }
    }
  }
}, 45_000);
