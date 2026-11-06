import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  attemptIdInput,
  attemptResourceNames,
  authoritySessionSchema,
  decodeBoundary,
  dockerAttemptPlanSchema,
  nodeIdSchema,
  resultOperations,
  workspaceVolumeInput,
} from "@loopy/contract";
import { canonicalJson, type Json } from "@loopy/core";
import { RegistryError } from "@loopy/runtime/service";
import { Cause, Effect, Exit } from "effect";
import { Miniflare } from "miniflare";
import { boundedRequest, readBoundedText } from "../../../apps/cloud/src/http";
import { SandboxProvider } from "../../../apps/cloud/src/provider";
import { compiledBody } from "./compiled-fixture";

const root = resolve(import.meta.dir, "../../..");

const token = "synthetic-cloud-native-bridge-token-0001";

let directory: string;

let runtime: Miniflare;

let stateRoot: string;

const hash = (value: Json) => createHash("sha256").update(canonicalJson(value)).digest("hex");

beforeAll(async () => {
  await mkdir(resolve(root, ".loopy/quality-tests"), { recursive: true });
  directory = await mkdtemp(resolve(root, ".loopy/quality-tests/cloud-native-"));
  await mkdir(resolve(directory, ".loopy/loopies"), { recursive: true });
  stateRoot = resolve(directory, "sandbox");

  const built = await Bun.build({
    entrypoints: [resolve(root, "apps/cloud/src/worker.ts")],
    target: "browser",
    outdir: directory,
  });

  if (!built.success) {
    throw new Error(built.logs.join("\n"));
  }

  runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    modules: true,
    scriptPath: resolve(directory, "worker.js"),
    compatibilityDate: "2026-07-30",
    durableObjects: {
      WORKSPACES: { className: "Workspace", useSQLite: true },
      SANDBOX_RECEIPTS: { className: "SandboxReceipts", useSQLite: true },
    },
    r2Buckets: ["ARTIFACTS", "RECEIPT_RESULTS"],
    bindings: {
      LOOPY_STAGE: "local",
      LOCAL_AUTH: JSON.stringify([
        { workspace: "alpha", token: "synthetic-cloud-native-principal-0001" },
      ]),
      SANDBOX_URL: "http://127.0.0.1:1",
      SANDBOX_TOKEN: "synthetic-unused",
      CONCURRENCY: "1",
      RECEIPTS_TOKEN: token,
      RECEIPTS_NAMESPACE: "native",
      RECEIPTS_ROOT: stateRoot,
    },
  });
  await runtime.ready;
});

afterAll(async () => {
  try {
    await runtime?.dispose();
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function command(operation: string, input: Json = {}) {
  const response = await runtime.dispatchFetch("http://127.0.0.1/internal/sandbox-receipts", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Loopy-Receipts-Namespace": "native" },
    body: JSON.stringify({ operation, input }),
  });

  return { status: response.status, body: await response.json() };
}

function plan(runId: string, attempt = 1) {
  const identity = {
    workspace: "alpha",
    executionKey: { runId, nodeId: decodeBoundary(nodeIdSchema)("work"), scope: [] },
    attempt,
  };

  const id = hash(attemptIdInput(stateRoot, identity));
  const volume = hash(workspaceVolumeInput(stateRoot, identity));

  return decodeBoundary(dockerAttemptPlanSchema)({
    ...identity,
    ...attemptResourceNames(id, volume),
    id,
    requestHash: "a".repeat(64),
    deadline: 2_000_000_000_000,
  });
}

test("receipt authority verifies immutable bytes before completion and fences stale epochs", async () => {
  const opened = await command("openSession", { expectedEpoch: 0, nonce: "first" });
  expect(opened.status).toBe(200);
  const session = decodeBoundary(authoritySessionSchema)(opened.body);
  const attempt = plan("native-receipt");
  expect(await command("admit", { session, plan: attempt })).toMatchObject({
    status: 200,
    body: { kind: "created" },
  });
  expect(await command("admit", { session, plan: attempt })).toMatchObject({
    body: { kind: "existing", record: { kind: "started" } },
  });
  const missing = { sha256: "f".repeat(64), size: 20 };
  expect(
    (
      await command("complete", {
        session,
        id: attempt.id,
        requestHash: attempt.requestHash,
        result: missing,
      })
    ).status,
  ).toBe(500);
  expect(await command("read", { id: attempt.id })).toMatchObject({ body: { kind: "started" } });
  const value = { kind: "succeeded", output: "verified", logs: [] };
  const written = await command("resultPut", { workspace: "alpha", value });
  expect(written.status).toBe(200);
  const ref = decodeBoundary(resultOperations.resultPut.output)(written.body);
  expect(
    await command("complete", {
      session,
      id: attempt.id,
      requestHash: attempt.requestHash,
      result: ref,
    }),
  ).toMatchObject({ status: 200, body: { kind: "finished" } });
  expect(await command("resultGet", { workspace: "alpha", ref })).toMatchObject({
    status: 200,
    body: value,
  });
  expect((await command("resultGet", { workspace: "bravo", ref })).status).toBe(500);
  expect(
    await command("beginExport", { session, attemptId: attempt.id, token: "export" }),
  ).toMatchObject({ body: { kind: "granted" } });
  expect(await command("admit", { session, plan: plan("native-receipt", 2) })).toMatchObject({
    body: { kind: "rejected", code: "workspace_busy" },
  });
  expect(
    await command("exportGuards", { volume: attempt.volume, after: null, limit: 10 }),
  ).toMatchObject({ body: { exports: [{ token: "export" }] } });
  expect(await command("endExport", { session, token: "export" })).toMatchObject({
    status: 200,
    body: null,
  });
  expect(
    await command("exportGuards", { volume: attempt.volume, after: null, limit: 10 }),
  ).toMatchObject({ body: { exports: [] } });
  const bucket = await runtime.getR2Bucket("RECEIPT_RESULTS");
  await bucket.put(`receipts/native/workspaces/alpha/results/${ref.sha256}`, "corrupt");
  expect((await command("resultGet", { workspace: "alpha", ref })).status).toBe(500);
  expect(await command("read", { id: attempt.id })).toMatchObject({ body: { kind: "finished" } });
  expect(
    (await command("openSession", { expectedEpoch: session.epoch, nonce: "second" })).status,
  ).toBe(200);
  expect(await command("admit", { session, plan: plan("stale") })).toMatchObject({
    body: { kind: "rejected", code: "stale_session" },
  });
});

test("receipt bridge rejects excess fields and preserves authentication envelopes", async () => {
  expect((await command("status", { extra: true })).status).toBe(400);

  const response = await runtime.dispatchFetch("http://127.0.0.1/internal/sandbox-receipts", {
    method: "POST",
    body: "{}",
  });

  expect(response.status).toBe(401);
});

test("provider transport failure is typed and cannot become an absent receipt", async () => {
  const artifacts = {
    getBundle: () =>
      Effect.fail(
        new RegistryError({
          operation: "fixture bundle",
          cause: "No bundle in this lookup-only fixture",
        }),
      ),
  };

  const provider = new SandboxProvider({
    url: "http://127.0.0.1:1",
    token: "synthetic",
    workspace: "alpha",
    artifacts,
  });

  const exit = await Effect.runPromiseExit(
    provider.lookup(
      { runId: "transport", nodeId: decodeBoundary(nodeIdSchema)("work"), scope: [] },
      1,
    ),
  );

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    const failures = exit.cause.reasons.filter(Cause.isFailReason);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toMatchObject({
      _tag: "DurableProviderError",
      operation: "lookup",
      reason: "transport",
    });
  }
});

test("lost start reply requires lookup of the same persisted attempt", async () => {
  let starts = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "POST") {
        starts++;

        return Response.json({ broken: true });
      }

      return Response.json({ kind: starts === 0 ? "none" : "started" });
    },
  });

  try {
    const provider = new SandboxProvider({
      url: server.url.origin,
      token: "synthetic",
      workspace: "alpha",
      artifacts: { getBundle: () => Effect.succeed(btoa("fixture bundle")) },
    });

    const key = { runId: "lost-start", nodeId: decodeBoundary(nodeIdSchema)("work"), scope: [] };

    const failed = await Effect.runPromiseExit(
      provider.start(key, 1, {
        kind: "code",
        bundleHash: "a".repeat(64),
        input: {},
        timeoutMs: 1000,
      }),
    );

    expect(Exit.isFailure(failed)).toBe(true);

    if (Exit.isFailure(failed)) {
      expect(failed.cause.reasons.filter(Cause.isFailReason)[0]?.error).toMatchObject({
        _tag: "DurableProviderError",
        reason: "protocol",
        operation: "start",
      });
    }

    expect(await Effect.runPromise(provider.lookup(key, 1))).toEqual({ kind: "started" });
    expect(starts).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("bounded stream cleanup retains typed limits and transport failures", async () => {
  let canceled = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(3));
    },
    cancel() {
      canceled = true;
    },
  });

  const oversized = await Effect.runPromiseExit(readBoundedText(new Response(stream), 2));
  expect(Exit.isFailure(oversized)).toBe(true);
  expect(canceled).toBe(true);
  expect(stream.locked).toBe(false);

  if (Exit.isFailure(oversized)) {
    expect(oversized.cause.reasons.filter(Cause.isFailReason)[0]?.error).toMatchObject({
      _tag: "BodyLimitError",
      limit: 2,
    });
  }

  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error("transport failed");
    },
  });

  const failure = await Effect.runPromiseExit(
    boundedRequest(new Request("http://127.0.0.1/", { method: "POST", body: broken })),
  );

  expect(Exit.isFailure(failure)).toBe(true);

  if (Exit.isFailure(failure)) {
    expect(failure.cause.reasons.filter(Cause.isFailReason)[0]?.error).toMatchObject({
      _tag: "CloudError",
      operation: "read body",
    });
  }

  expect(broken.locked).toBe(false);
});

test("request limits preserve combined cleanup failure instead of returning HTTP400", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(24 * 1024 * 1024 + 1));
    },
    cancel() {
      return Promise.reject(new Error("cancel rejected"));
    },
  });

  const exit = await Effect.runPromiseExit(
    boundedRequest(new Request("http://127.0.0.1/", { method: "POST", body: stream })),
  );

  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    expect(errors).toContainEqual(expect.objectContaining({ _tag: "BodyLimitError" }));
    expect(errors).toContainEqual(
      expect.objectContaining({ _tag: "CloudError", operation: "cancel body" }),
    );
  }

  expect(stream.locked).toBe(false);
});

test("interrupted reads bound stalled cancellation and release the reader lock", async () => {
  let entered: () => void = () => {};

  const pulling = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let canceled = false;

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      entered();

      return new Promise(() => {});
    },
    cancel() {
      canceled = true;

      return new Promise(() => {});
    },
  });

  const abort = new AbortController();

  const result = Effect.runPromiseExit(readBoundedText(new Response(stream), 10), {
    signal: abort.signal,
  });

  await pulling;
  abort.abort();
  const exit = await result;
  expect(canceled).toBe(true);
  expect(stream.locked).toBe(false);
  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(
      exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
    ).toContainEqual(expect.objectContaining({ _tag: "CloudError", operation: "cancel body" }));
  }
}, 3000);

test("empty authorized receipt request remains invalid_request400", async () => {
  const response = await runtime.dispatchFetch("http://127.0.0.1/internal/sandbox-receipts", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Loopy-Receipts-Namespace": "native" },
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});

test("Worker retains forbidden for foreign run/save bodies and not_yet cloud routes", async () => {
  const credential = "synthetic-cloud-native-principal-0001";
  const foreign = await compiledBody("foreign", "/fixture.ts", { workspace: "other" });

  for (const [path, method, body] of [
    ["/loopies/foreign/runs", "POST", { input: {}, workspace: "other" }],
    ["/loopies/foreign", "PUT", foreign],
  ] as const) {
    const response = await runtime.dispatchFetch(`http://127.0.0.1/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  }

  for (const [path, method] of [
    ["/secrets", "GET"],
    ["/types", "POST"],
  ] as const) {
    const response = await runtime.dispatchFetch(`http://127.0.0.1/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${credential}` },
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: "not_yet" } });
  }
});
