import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Miniflare } from "miniflare";
import { HttpSandboxAuthority } from "../../../../apps/sandbox/src/http-authority.js";
import { authorityCommandSchema } from "../../src/contract/sandbox-journal-rpc.js";

export const repository = resolve(import.meta.dir, "../../../..");

export const bridgeToken = "architecture-docker-synthetic-bridge-0001";

export const namespace = "architecture-docker-durable";

type ProofEvent = { operation: string } | { proof: string };

export async function bounded<T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> {
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

export async function eventually(check: () => Promise<boolean>, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await delay(50);
  }

  assert.fail(`${label} did not become true within ${ms} ms.`);
}

export async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });

  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );

  return paths.flat().sort();
}

export async function snapshot(paths: string[]) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: Bun.CryptoHasher.hash("sha256", await readFile(path), "hex"),
    })),
  );
}

export function decodedProxyResponse(response: Response, bytes: ArrayBuffer) {
  const headers = new Headers(response.headers);

  // Fetch decoded the body, so upstream compression and transfer sizes no longer describe it.
  for (const name of ["content-encoding", "content-length", "transfer-encoding"]) {
    headers.delete(name);
  }

  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}

export async function dockerRuntime() {
  const parent = join(repository, ".loopy/architecture-tests");
  await mkdir(parent, { recursive: true });
  const directory = await realpath(await mkdtemp(join(parent, "docker-durable-")));
  const stateRoot = join(directory, ".loopy/cloud/sandbox");
  const events: (ProofEvent & { at: string })[] = [];
  const faults = { admissionRepliesDropped: 0, readsBlocked: 0 };

  const record = <T extends ProofEvent>(event: T) => {
    events.push({ at: new Date().toISOString(), ...event });
  };

  const bundle = await Bun.build({
    entrypoints: [join(repository, "apps/cloud/src/worker.ts")],
    target: "browser",
    format: "esm",
    outdir: join(directory, "bundle"),
    naming: "[name].js",
  });

  assert(bundle.success, `Worker bundle failed: ${bundle.logs.join("\n")}`);

  const bindings = {
    LOOPY_STAGE: "local",
    LOCAL_AUTH: JSON.stringify([
      { token: "architecture-docker-synthetic-principal-0001", workspace: "proof" },
    ]),
    SANDBOX_URL: "http://127.0.0.1:1",
    SANDBOX_TOKEN: "architecture-docker-unused-provider-token",
    CONCURRENCY: "1",
    RECEIPTS_TOKEN: bridgeToken,
    RECEIPTS_NAMESPACE: namespace,
    RECEIPTS_ROOT: stateRoot,
  };

  function start() {
    return new Miniflare({
      host: "127.0.0.1",
      port: 0,
      modules: true,
      scriptPath: join(directory, "bundle/worker.js"),
      compatibilityDate: "2026-07-30",
      durableObjects: {
        WORKSPACES: { className: "Workspace", useSQLite: true },
        SANDBOX_RECEIPTS: { className: "SandboxReceipts", useSQLite: true },
      },
      durableObjectsPersist: join(directory, "do"),
      r2Persist: join(directory, "r2"),
      r2Buckets: { ARTIFACTS: "proof-artifacts", RECEIPT_RESULTS: "proof-results" },
      bindings,
    });
  }

  let runtime = start();
  let origin = (await runtime.ready).origin;

  let fault:
    | { kind: "healthy" }
    | { kind: "admission"; reads: number | "all"; committed: boolean } = { kind: "healthy" };

  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const command = authorityCommandSchema.parse(JSON.parse(body));

      if (
        fault.kind === "admission" &&
        fault.committed &&
        command.operation === "read" &&
        fault.reads !== 0
      ) {
        if (fault.reads !== "all") {
          fault.reads -= 1;
        }

        faults.readsBlocked += 1;
        record({ operation: command.operation, fault: "read-unavailable", input: command.input });

        return new Response("injected authority read outage", { status: 503 });
      }

      const response = await fetch(new URL("/internal/sandbox-receipts", origin), {
        method: "POST",
        headers: request.headers,
        body,
        signal: AbortSignal.timeout(6000),
      });

      const bytes = await response.arrayBuffer();
      record({
        operation: command.operation,
        input: command.input,
        status: response.status,
        upstreamEncoding: response.headers.get("content-encoding"),
        upstreamLength: response.headers.get("content-length"),
        upstreamTransferEncoding: response.headers.get("transfer-encoding"),
        response: new TextDecoder().decode(bytes),
      });

      if (fault.kind === "admission" && !fault.committed && command.operation === "admit") {
        assert.equal(response.status, 200);
        fault.committed = true;
        faults.admissionRepliesDropped += 1;
        record({ operation: "admit", fault: "committed-response-replaced-with-503" });

        return new Response("injected lost admission acknowledgement", { status: 503 });
      }

      return decodedProxyResponse(response, bytes);
    },
  });

  record({
    operation: "runtime-start",
    origin,
    proxy: proxy.url.origin,
    directory,
    stateRoot,
    namespace,
  });

  const authorityAt = (url: string) =>
    new HttpSandboxAuthority({ url, token: bridgeToken, namespace });

  return {
    directory,
    stateRoot,
    record,
    faults,
    authority: authorityAt(proxy.url.origin),
    get direct() {
      return authorityAt(origin);
    },
    loseAdmission(reads: number | "all") {
      fault = { kind: "admission", reads, committed: false };
    },
    heal() {
      fault = { kind: "healthy" };
    },
    async reopen() {
      await runtime.dispose();
      runtime = start();
      origin = (await runtime.ready).origin;
      record({ operation: "runtime-reconstructed", origin });
    },
    async close() {
      await proxy.stop(true);
      await runtime.dispose();
      await writeFile(join(directory, "authority-events.json"), JSON.stringify(events, null, 2));
    },
  };
}

export type DockerRuntime = Awaited<ReturnType<typeof dockerRuntime>>;
