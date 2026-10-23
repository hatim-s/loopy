import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { attemptHash } from "../../../../apps/sandbox/src/admission.js";
import { HttpSandboxAuthority } from "../../../../apps/sandbox/src/http-authority.js";
import { dockerAttemptPlanSchema, nodeIdSchema } from "../../src/contract/index.js";

export const bridgeToken = "synthetic-receipt-bridge-credential-0001";

export const principalToken = "synthetic-receipt-principal-credential-0001";

export const namespace = "synthetic-receipt-authority";

export async function receiptHarness(configuration: { stage?: string; token?: string } = {}) {
  const root = resolve(import.meta.dir, "../../../..");
  const parent = resolve(root, ".loopy/architecture-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(`${parent}/receipts-`);
  const stateRoot = resolve(directory, "sandbox");

  const bundle = await Bun.build({
    entrypoints: [
      resolve(root, "apps/cloud/src/worker.ts"),
      resolve(import.meta.dir, "receipt-rollback-probe.ts"),
      resolve(import.meta.dir, "receipt-count-probe.ts"),
    ],
    target: "browser",
    format: "esm",
    outdir: directory,
    naming: "[name].js",
  });

  if (!bundle.success) {
    throw new Error(`Receipt fixture bundle failed: ${bundle.logs.join("\n")}`);
  }

  const bindings = {
    LOOPY_STAGE: configuration.stage ?? "local",
    LOCAL_AUTH: JSON.stringify([{ token: principalToken, workspace: "alpha" }]),
    SANDBOX_URL: "http://127.0.0.1:1",
    SANDBOX_TOKEN: "synthetic-unused-provider-token",
    CONCURRENCY: "1",
    RECEIPTS_TOKEN: configuration.token ?? bridgeToken,
    RECEIPTS_NAMESPACE: namespace,
    RECEIPTS_ROOT: stateRoot,
  };

  function start() {
    return new Miniflare({
      host: "127.0.0.1",
      port: 0,
      durableObjectsPersist: resolve(directory, "do"),
      r2Persist: resolve(directory, "r2"),
      workers: [
        {
          name: "cloud",
          modules: true,
          scriptPath: resolve(directory, "worker.js"),
          compatibilityDate: "2026-07-30",
          durableObjects: {
            WORKSPACES: { className: "Workspace", useSQLite: true },
            SANDBOX_RECEIPTS: { className: "SandboxReceipts", useSQLite: true },
          },
          r2Buckets: { ARTIFACTS: "synthetic-artifacts", RECEIPT_RESULTS: "synthetic-results" },
          bindings,
        },
        {
          name: "rollback",
          modules: true,
          scriptPath: resolve(directory, "receipt-rollback-probe.js"),
          compatibilityDate: "2026-07-30",
          durableObjects: { PROBE: { className: "ReceiptRollbackProbe", useSQLite: true } },
        },
        {
          name: "counts",
          modules: true,
          scriptPath: resolve(directory, "receipt-count-probe.js"),
          compatibilityDate: "2026-07-30",
          durableObjects: { COUNTS: { className: "ReceiptCountProbe", useSQLite: true } },
          r2Buckets: { RECEIPT_RESULTS: "synthetic-results" },
          bindings,
        },
      ],
    });
  }

  let runtime = start();
  let origin = (await runtime.ready).origin;

  return {
    directory,
    stateRoot,
    get runtime() {
      return runtime;
    },
    get origin() {
      return origin;
    },
    get authority() {
      return new HttpSandboxAuthority({ url: origin, token: bridgeToken, namespace });
    },
    plan(runId: string, attempt = 1, workspace = "alpha") {
      const executionKey = { runId, nodeId: nodeIdSchema.parse("0:command"), scope: [] };
      const id = attemptHash({ root: stateRoot, workspace, executionKey, attempt });

      return dockerAttemptPlanSchema.parse({
        id,
        workspace,
        executionKey,
        attempt,
        requestHash: "a".repeat(64),
        container: `loopy-attempt-${id}`,
        inputVolume: `loopy-input-${id}`,
        volume: `loopy-workspace-${attemptHash({ root: stateRoot, workspace, runId })}`,
        deadline: 2_000_000_000_000,
      });
    },
    async reopen() {
      await runtime.dispose();
      runtime = start();
      origin = (await runtime.ready).origin;
    },
    async close() {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export type ReceiptHarness = Awaited<ReturnType<typeof receiptHarness>>;
