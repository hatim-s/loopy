import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForWorker } from "../../../dev/playground/readiness";
import { receiptBindingsSchema } from "../../../dev/playground/receipt/bindings";
import { requireFreshDurableRoot } from "../../../dev/playground/receipt/selection";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("durable selection rejects filesystem receipts and unreleased export guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-receipt-selection-"));
  roots.push(root);
  await mkdir(join(root, "receipts"));
  await mkdir(join(root, "exports"));
  await requireFreshDurableRoot(root);
  const path = join(root, "receipts", `${"a".repeat(64)}.json`);
  await writeFile(path, JSON.stringify({ kind: "started" }));
  await expect(requireFreshDurableRoot(root)).rejects.toThrow("populated filesystem receipts");
  await rm(path);
  await writeFile(join(root, "exports", `${"b".repeat(64)}.json`), "{}");
  await expect(requireFreshDurableRoot(root)).rejects.toThrow("export guards");
});

test("architecture rejects missing authority and results bindings", () => {
  const input = {
    durable_objects: { bindings: [{ name: "SANDBOX_RECEIPTS", class_name: "SandboxReceipts" }] },
    r2_buckets: [{ binding: "RECEIPT_RESULTS" }],
  };

  expect(() => receiptBindingsSchema.parse(input)).not.toThrow();
  expect(() =>
    receiptBindingsSchema.parse({ ...input, durable_objects: { bindings: [] } }),
  ).toThrow("SANDBOX_RECEIPTS");
  expect(() => receiptBindingsSchema.parse({ ...input, r2_buckets: [] })).toThrow(
    "RECEIPT_RESULTS",
  );
});

test("worker readiness retries transport and wrong health before accepting the local Worker", async () => {
  let calls = 0;
  await waitForWorker("http://127.0.0.1:15270", { exitCode: null }, async (url) => {
    expect(url).toBe("http://127.0.0.1:15270/health");
    calls++;

    if (calls === 1) {
      throw new Error("Worker is still binding");
    }

    if (calls === 2) {
      return Response.json({ service: "different" });
    }

    return Response.json({ service: "loopy-cloud", stage: "local" });
  });
  expect(calls).toBe(3);
});

test("worker exit rejects readiness before any sandbox admission can proceed", async () => {
  let calls = 0;
  await expect(
    waitForWorker("http://127.0.0.1:15270", { exitCode: 1 }, async () => {
      calls++;

      return Response.json({ service: "loopy-cloud", stage: "local" });
    }),
  ).rejects.toThrow("Owned Worker exited");
  expect(calls).toBe(0);
});
