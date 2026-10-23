import { FilesystemAuthority } from "../../apps/sandbox/src/filesystem-authority.js";
import { FilesystemResults } from "../../apps/sandbox/src/immutable-results.js";
import type { StoredReceipt } from "../../apps/sandbox/src/receipts.js";

/** Read retained fixture state without opening a writer session or changing its format. */
export async function filesystemReceipt(root: string, id: string): Promise<StoredReceipt> {
  const record = await new FilesystemAuthority(root).read(id);

  if (!record) {
    throw new Error(`Fixture receipt ${id} is missing.`);
  }

  if (record.kind === "started") {
    return { ...record.plan, kind: "started" };
  }

  const result =
    record.result.kind === "inline"
      ? record.result.value
      : await new FilesystemResults(root, record.plan.workspace).get(record.result.ref);

  return { ...record.plan, kind: "finished", result };
}
