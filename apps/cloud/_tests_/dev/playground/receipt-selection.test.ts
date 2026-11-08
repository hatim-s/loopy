import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { qualityTestRoot } from "../../../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { requireFreshDurableRoot } from "../../../dev/playground/receipt/selection";

test("durable selection rejects filesystem receipts and unreleased export guards", async () => {
  const root = qualityTestRoot("receipt-selection");
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
