import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary, nodeIdSchema } from "@loopy/contract";
import { attemptResources, dockerAttemptPlanSchema } from "@loopy/contract/sandbox";
import { Effect, Exit, Scope } from "effect";
import { Miniflare } from "miniflare";
import { bundleForBrowser } from "../../../../packages/runtime/_tests_/fixtures/bundle";
import { qualityTestRoot } from "../../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { HttpSandboxAuthority } from "../../../sandbox/src/http-authority";

export const bridgeToken = "synthetic-receipt-bridge-credential-0001";

export const principalToken = "synthetic-receipt-principal-credential-0001";

export const namespace = "synthetic-receipt-authority";

export async function receiptHarness(configuration: { stage?: string; token?: string } = {}) {
  // Callers allocate in beforeAll, so the harness owns its scope and closes it in close().
  const scope = Scope.makeUnsafe();
  const release = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const directory = qualityTestRoot("receipts", { scope });
  await writeFile(resolve(directory, "package.json"), JSON.stringify({ private: true }));
  const stateRoot = resolve(directory, "sandbox");

  await bundleForBrowser(
    [
      resolve(import.meta.dir, "../../src/worker.ts"),
      resolve(import.meta.dir, "receipt-rollback-probe.ts"),
      resolve(import.meta.dir, "receipt-count-probe.ts"),
    ],
    directory,
  );

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
          serviceBindings: { CLOUD: "cloud" },
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
    async plan(runId: string, attempt = 1, workspace = "alpha") {
      const identity = {
        workspace,
        executionKey: { runId, nodeId: decodeBoundary(nodeIdSchema)("0:command"), scope: [] },
        attempt,
      };

      return decodeBoundary(dockerAttemptPlanSchema)({
        ...identity,
        ...(await attemptResources(stateRoot, identity)),
        requestHash: "a".repeat(64),
        deadline: 2_000_000_000_000,
      });
    },
    async reopen() {
      await runtime.dispose();
      runtime = start();
      origin = (await runtime.ready).origin;
    },
    async close() {
      try {
        await runtime.dispose();
      } finally {
        await release();
      }
    },
  };
}

export type ReceiptHarness = Awaited<ReturnType<typeof receiptHarness>>;
