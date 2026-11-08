import { expect, test } from "bun:test";
import { join } from "node:path";
import { qualityTestRoot } from "../../../../../packages/runtime/_tests_/fixtures/quality-test-root";
import { filesystemReceipts } from "../../../dev/filesystem-receipt";
import { readAdmissions } from "../../../dev/playground/journal";

// A stack that stopped before writing state, or a copy analyzed before any driver ran, owns
// nothing yet. Cleanup and diagnostics must see an empty list instead of failing.
test("dev tools read a root without receipts or journals as empty", async () => {
  const root = qualityTestRoot("missing-state");

  expect(await filesystemReceipts(join(root, "sandbox"))).toEqual([]);
  expect(await readAdmissions(join(root, "journal"))).toEqual([]);
});
