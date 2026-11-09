import { readdir } from "node:fs/promises";
import { HttpSandboxAuthority } from "../../../../sandbox/src/http-authority";
import { stateLayout } from "../../../../sandbox/src/state-root";
import { type Config, profile } from "../config";

// The caller holds the bridge root lock before selecting a new authority.
export async function requireFreshDurableRoot(root: string) {
  const layout = stateLayout(root);

  for (const directory of [layout.receipts, layout.exports]) {
    if ((await readdir(directory)).length > 0) {
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
