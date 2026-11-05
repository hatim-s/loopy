import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { receiptHash } from "../../../apps/cloud/src/receipts-identity.js";
import {
  type AuthorityCommand,
  decodeBoundary,
  resultOperations,
  SANDBOX_MAX_CAPTURE_BYTES,
} from "../src/contract/index.js";
import {
  bridgeToken,
  namespace,
  type ReceiptHarness,
  receiptHarness,
} from "./fixtures/receipt-harness.js";

let harness: ReceiptHarness;

beforeAll(async () => {
  harness = await receiptHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

function key(hash: string, workspace = "alpha") {
  return `receipts/${namespace}/workspaces/${workspace}/results/${hash}`;
}

test("actual R2 request counts are one PUT on fresh publication and one GET for pointer verification", async () => {
  const ns = await harness.runtime.getDurableObjectNamespace("COUNTS", "counts");
  const object = ns.get(ns.idFromName(namespace));

  async function command(value: AuthorityCommand) {
    const response = await object.fetch("http://127.0.0.1/internal/sandbox-receipts", {
      method: "POST",
      headers: { Authorization: `Bearer ${bridgeToken}`, "X-Loopy-Receipts-Namespace": namespace },
      body: JSON.stringify(value),
    });

    expect(response.status).toBe(200);

    return response.json();
  }

  async function counts() {
    return (await object.fetch("http://probe/counts")).json();
  }

  const session = { epoch: 1, nonce: "counts" };
  const plan = harness.plan("counts");
  await command({ operation: "openSession", input: { expectedEpoch: 0, nonce: session.nonce } });
  await command({ operation: "admit", input: { session, plan } });
  const value = { kind: "succeeded" as const, output: "counted", logs: [] };

  const ref = decodeBoundary(resultOperations.resultPut.output)(
    await command({ operation: "resultPut", input: { workspace: "alpha", value } }),
  );

  expect(await counts()).toEqual({ put: 1, get: 0 });
  await command({
    operation: "complete",
    input: { session, id: plan.id, requestHash: plan.requestHash, result: ref },
  });
  expect(await counts()).toEqual({ put: 1, get: 1 });
  await command({ operation: "resultGet", input: { workspace: "alpha", ref } });
  expect(await counts()).toEqual({ put: 1, get: 2 });
  await command({ operation: "resultPut", input: { workspace: "alpha", value } });
  expect(await counts()).toEqual({ put: 2, get: 3 });
});

test("R2 computes canonical hashes server-side, conditional-creates results and scopes reads by workspace", async () => {
  const result = { kind: "succeeded" as const, output: { answer: 42 }, logs: [] };
  const results = harness.authority.resultsFor("alpha");
  const ref = await Effect.runPromise(results.put(result));
  expect(await Effect.runPromise(results.put(result))).toEqual(ref);
  expect(await Effect.runPromise(results.get(ref))).toEqual(result);
  const bucket = await harness.runtime.getR2Bucket("RECEIPT_RESULTS", "cloud");
  const object = await bucket.get(key(ref.sha256));

  if (!object) {
    throw new Error("Result object was not published.");
  }

  expect(object?.size).toBe(ref.size);
  expect(await Effect.runPromise(receiptHash(new Uint8Array(await object.arrayBuffer())))).toBe(
    ref.sha256,
  );

  const collision = await bucket.put(key(ref.sha256), "replacement", {
    onlyIf: { etagDoesNotMatch: "*" },
  });

  expect(collision).toBeNull();
  expect(await Effect.runPromise(results.get(ref))).toEqual(result);
  await expect(Effect.runPromise(harness.authority.resultsFor("bravo").get(ref))).rejects.toThrow(
    "HTTP 500",
  );
});

test("SQL never publishes an unverified result pointer; orphan bytes leave the receipt started", async () => {
  const authority = harness.authority;

  const session = await Effect.runPromise(
    authority.openSession({
      expectedEpoch: (await Effect.runPromise(authority.status())).epoch,
      nonce: "publication",
    }),
  );

  const plan = harness.plan("publication");
  await Effect.runPromise(authority.admit({ session, plan }));
  const missing = { sha256: "f".repeat(64), size: 20 };
  await expect(
    Effect.runPromise(
      authority.complete({ session, id: plan.id, requestHash: plan.requestHash, result: missing }),
    ),
  ).rejects.toThrow("HTTP 500");
  expect(await Effect.runPromise(authority.read(plan.id))).toMatchObject({ kind: "started" });

  const ref = await Effect.runPromise(
    authority
      .resultsFor("alpha")
      .put({ kind: "succeeded", output: "orphan-until-complete", logs: [] }),
  );

  expect(await Effect.runPromise(authority.read(plan.id))).toMatchObject({ kind: "started" });
  expect(
    await Effect.runPromise(
      authority.complete({ session, id: plan.id, requestHash: plan.requestHash, result: ref }),
    ),
  ).toMatchObject({ kind: "finished" });
  expect(
    await Effect.runPromise(
      authority.complete({
        session,
        id: plan.id,
        requestHash: plan.requestHash,
        result: missing,
      }),
    ),
  ).toEqual({ kind: "rejected", code: "request_conflict" });
  const bucket = await harness.runtime.getR2Bucket("RECEIPT_RESULTS", "cloud");
  await bucket.delete(key(ref.sha256));
  await expect(Effect.runPromise(authority.resultsFor("alpha").get(ref))).rejects.toThrow(
    "HTTP 500",
  );
  // The admission tombstone remains terminal even if its blob becomes unavailable.
  expect(await Effect.runPromise(authority.admit({ session, plan }))).toMatchObject({
    kind: "existing",
    record: { kind: "finished" },
  });
  await expect(
    Effect.runPromise(
      authority.complete({ session, id: plan.id, requestHash: plan.requestHash, result: ref }),
    ),
  ).rejects.toThrow("HTTP 500");
});

test("missing, mismatched, malformed and oversized R2 results fail closed", async () => {
  const results = harness.authority.resultsFor("alpha");
  const bucket = await harness.runtime.getR2Bucket("RECEIPT_RESULTS", "cloud");

  const ref = await Effect.runPromise(
    results.put({ kind: "succeeded", output: "integrity", logs: [] }),
  );

  const original = await bucket.get(key(ref.sha256));

  if (!original) {
    throw new Error("Result object was not published.");
  }

  const bytes = new TextEncoder().encode((await original.text()).replace("integrity", "different"));
  expect(bytes.byteLength).toBe(ref.size);
  await bucket.put(key(ref.sha256), bytes);
  await expect(Effect.runPromise(results.get(ref))).rejects.toThrow("HTTP 500");
  await bucket.put(key(ref.sha256), "larger".repeat(ref.size));
  await expect(Effect.runPromise(results.get(ref))).rejects.toThrow("HTTP 500");
  await expect(
    Effect.runPromise(results.put({ kind: "succeeded", output: "integrity", logs: [] })),
  ).rejects.toThrow("HTTP 500");
  const malformed = new TextEncoder().encode("{}");

  const badRef = {
    sha256: await Effect.runPromise(receiptHash(malformed)),
    size: malformed.byteLength,
  };

  await bucket.put(key(badRef.sha256), malformed);
  await expect(Effect.runPromise(results.get(badRef))).rejects.toThrow("HTTP 500");
  await expect(
    Effect.runPromise(results.get({ sha256: badRef.sha256, size: SANDBOX_MAX_CAPTURE_BYTES + 1 })),
  ).rejects.toThrow("HTTP 400");
});

test("oversized canonical results become a bounded output_limit failure before publication", async () => {
  const results = harness.authority.resultsFor("alpha");

  const ref = await Effect.runPromise(
    results.put({
      kind: "succeeded",
      output: "x".repeat(SANDBOX_MAX_CAPTURE_BYTES),
      logs: [],
    }),
  );

  expect(ref.size).toBeLessThan(256);
  expect(await Effect.runPromise(results.get(ref))).toEqual({
    kind: "failed",
    error: { code: "output_limit", message: "Serialized attempt result exceeds 2 MiB." },
    exitCode: null,
    logs: [],
  });
});
