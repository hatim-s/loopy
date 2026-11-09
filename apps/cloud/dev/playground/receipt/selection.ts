import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HttpSandboxAuthority } from "../../../../sandbox/src/http-authority";
import { type Config, profile } from "../config";

// The caller holds the bridge root lock before selecting a new authority.
export async function requireFreshDurableRoot(root: string) {
  for (const directory of ["receipts", "exports"]) {
    if ((await readdir(join(root, directory))).length > 0) {
      throw new Error(
        "Durable receipt selection refuses populated filesystem receipts or export guards. Use a fresh root.",
      );
    }
  }
}

export function receiptAuthority(settings: Extract<Config, { receiptMode: "durable-object" }>) {
  return new HttpSandboxAuthority({
    url: profile.api,
    token: settings.receiptsToken,
    namespace: profile.batchPrefix,
  });
}
