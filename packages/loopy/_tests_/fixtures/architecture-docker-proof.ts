import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";
import { z } from "zod";
import { HttpSandboxAuthority } from "../../../../apps/sandbox/src/http-authority.js";
import { type Bridge, resources } from "./architecture-docker-resources.js";
import {
  bounded,
  decodedProxyResponse,
  dockerRuntime,
  filesBelow,
  repository,
  snapshot,
} from "./architecture-docker-runtime.js";
import {
  durableAndGuard,
  killedAndDeadline,
  shutdownOutage,
} from "./architecture-docker-scenarios.js";

export async function proxySanityProbe() {
  const bytes = Buffer.from('{"epoch":0}');
  const compressed = gzipSync(bytes);

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(compressed, {
        headers: {
          "content-encoding": "gzip",
          "content-length": String(compressed.byteLength),
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-loopy-proxy-probe": "preserved",
        },
      }),
  });

  const observations: {
    encoding: string | null;
    compressedLength: string | null;
    decodedLength: number;
  }[] = [];

  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = await fetch(upstream.url, { signal: AbortSignal.timeout(1000) });
      const decoded = await response.arrayBuffer();
      observations.push({
        encoding: response.headers.get("content-encoding"),
        compressedLength: response.headers.get("content-length"),
        decodedLength: decoded.byteLength,
      });

      return new URL(request.url).pathname === "/raw"
        ? new Response(decoded, { headers: response.headers })
        : decodedProxyResponse(response, decoded);
    },
  });

  let rawError: string | undefined;

  try {
    await bounded(
      (async () => {
        try {
          await (
            await fetch(new URL("/raw", proxy.url), { signal: AbortSignal.timeout(1000) })
          ).text();
        } catch (cause) {
          assert(cause instanceof Error && "code" in cause);
          assert.equal(cause.code, "ZlibError");
          rawError = String(cause);
        }

        assert(rawError, "The unchanged-header control must reproduce decompression failure.");
        const fixed = await fetch(proxy.url, { signal: AbortSignal.timeout(1000) });
        assert.equal(await fixed.text(), bytes.toString());
        assert.equal(fixed.headers.get("content-encoding"), null);
        assert.equal(fixed.headers.get("content-type"), "application/json");
        assert.equal(fixed.headers.get("cache-control"), "no-store");
        assert.equal(fixed.headers.get("x-loopy-proxy-probe"), "preserved");

        const authority = new HttpSandboxAuthority({
          url: proxy.url.origin,
          token: "synthetic-proxy-sanity-credential-0001",
          namespace: "proxy-sanity",
        });

        assert.deepEqual(await Effect.runPromise(authority.status()), { epoch: 0 });

        const direct = decodedProxyResponse(
          new Response(bytes, {
            status: 201,
            statusText: "Created",
            headers: {
              "content-encoding": "gzip",
              "content-length": "999",
              "transfer-encoding": "chunked",
              "x-loopy-proxy-probe": "preserved",
            },
          }),
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );

        for (const name of ["content-encoding", "content-length", "transfer-encoding"]) {
          assert.equal(direct.headers.get(name), null);
        }

        assert.equal(direct.status, 201);
        assert.equal(direct.statusText, "Created");
        assert.equal(direct.headers.get("x-loopy-proxy-probe"), "preserved");
        assert.equal(observations.length, 3);
        assert(
          observations.every(
            (entry) => entry.encoding === "gzip" && entry.decodedLength === bytes.byteLength,
          ),
        );
      })(),
      "Local gzip proxy sanity",
      5000,
    );
  } finally {
    await proxy.stop(true);
    await upstream.stop(true);
  }

  const parent = join(repository, ".loopy/architecture-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "docker-proxy-sanity-"));

  const result = {
    status: "passed",
    at: new Date().toISOString(),
    upstream: upstream.url.origin,
    proxy: proxy.url.origin,
    listenersStopped: true,
    rawError,
    observations,
    dockerCommands: 0,
    workerdRuntimes: 0,
    admissions: 0,
  };

  await writeFile(join(directory, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, directory }));
}

const configurationSchema = z.strictObject({
  gate: z.literal("root-runtime-stable"),
  image: z.string().regex(/^loopy-sandbox:architecture-[a-zA-Z0-9_.-]+$/),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

type Outcome =
  | { status: "incomplete" }
  | { status: "passed"; workersStarted: number; sequential: boolean }
  | { status: "failed"; error: string; stack: string | undefined };

async function main() {
  // No listener, workerd runtime or Docker command starts before this explicit gate.
  const selected = configurationSchema.parse({
    gate: process.env.LOOPY_ARCHITECTURE_DOCKER_GATE,
    image: process.env.LOOPY_ARCHITECTURE_DOCKER_IMAGE,
    imageId: process.env.LOOPY_ARCHITECTURE_DOCKER_IMAGE_ID,
  });

  const sourcePaths = (
    await Promise.all([
      filesBelow(join(repository, "apps/sandbox/src")),
      filesBelow(join(repository, "apps/cloud/src")),
      filesBelow(join(repository, "packages/loopy/src")),
      filesBelow(join(repository, "packages/loopy/_tests_/fixtures")),
    ])
  )
    .flat()
    .filter((path) => path.endsWith(".ts"));

  const sourceBefore = await snapshot(sourcePaths);
  const runtime = await dockerRuntime();
  const owned = resources(runtime, selected);
  let bridge: Bridge | undefined;
  let outcome: Outcome = { status: "incomplete" };
  let failure: Error | undefined;
  const started = new Date().toISOString();
  console.log(`Owned proof root: ${runtime.directory}`);

  try {
    await writeFile(
      join(runtime.directory, "source-before.json"),
      JSON.stringify(sourceBefore, null, 2),
    );
    await writeFile(
      join(runtime.directory, "worker-bundle.json"),
      JSON.stringify(await snapshot([join(runtime.directory, "bundle/worker.js")]), null, 2),
    );
    await owned.preflight();
    await bounded(
      (async () => {
        bridge = await durableAndGuard(runtime, owned, (service) => {
          bridge = service;
        });
        await killedAndDeadline(runtime, owned, bridge);
        await shutdownOutage(runtime, owned, bridge);
        bridge = undefined;
      })(),
      "Scenarios before cleanup",
      100_000,
    );
    assert.equal(
      [...owned.starts.values()].reduce((sum, count) => sum + count, 0),
      4,
    );
    outcome = { status: "passed", workersStarted: 4, sequential: true };
  } catch (cause) {
    failure = cause instanceof Error ? cause : new Error("Docker durable proof failed.", { cause });
    outcome = {
      status: "failed",
      error: String(cause),
      stack: cause instanceof Error ? cause.stack : undefined,
    };
  } finally {
    runtime.heal();
    owned.healCleanup();
    const cleanupErrors: string[] = [];

    if (bridge) {
      try {
        await owned.stop(bridge);
      } catch (cause) {
        cleanupErrors.push(String(cause));
      }
    }

    try {
      await owned.cleanup();
    } catch (cause) {
      cleanupErrors.push(String(cause));
    }

    try {
      await runtime.close();
    } catch (cause) {
      cleanupErrors.push(String(cause));
    }

    const sourceAfter = await snapshot(sourcePaths);
    await writeFile(
      join(runtime.directory, "source-after.json"),
      JSON.stringify(sourceAfter, null, 2),
    );

    const changed = sourceBefore
      .filter((entry, index) => entry.sha256 !== sourceAfter[index]?.sha256)
      .map((entry) => relative(repository, entry.path));

    const changedCritical = changed.filter((path) =>
      /^(apps\/sandbox\/src\/|apps\/cloud\/src\/(receipts[^/]*|worker|environment|http)\.ts$|packages\/loopy\/src\/contract\/sandbox[^/]*\.ts$|packages\/loopy\/_tests_\/fixtures\/architecture-docker-)/.test(
        path,
      ),
    );

    const finalOutcome =
      cleanupErrors.length === 0 && changedCritical.length === 0
        ? outcome
        : {
            status: "failed",
            scenarioOutcome: outcome,
            reason: "Cleanup or receipt source stability verification failed.",
          };

    await writeFile(
      join(runtime.directory, "storage-files.json"),
      JSON.stringify(
        await snapshot(
          (await filesBelow(runtime.directory)).filter((path) => /\/(do|r2)\//.test(path)),
        ),
        null,
        2,
      ),
    );
    await writeFile(
      join(runtime.directory, "report.json"),
      JSON.stringify(
        {
          started,
          ended: new Date().toISOString(),
          ...finalOutcome,
          selected,
          changedSources: changed,
          changedCriticalSources: changedCritical,
          cleanupErrors,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        ...finalOutcome,
        evidence: runtime.directory,
        changedSources: changed,
        changedCriticalSources: changedCritical,
        cleanupErrors,
      }),
    );
    assert.equal(cleanupErrors.length, 0, cleanupErrors.join("\n"));
    assert.deepEqual(
      changedCritical,
      [],
      "Receipt source changed during live proof. Rerun against a stable candidate.",
    );
  }

  if (failure) {
    throw failure;
  }
}

if (import.meta.main) {
  await bounded(main(), "Complete Docker durable proof", 180_000);
}
