import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
