import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

export function readmodelDirectory() {
  const parent = resolve(import.meta.dir, "../../../..", ".loopy/architecture-tests");
  mkdirSync(parent, { recursive: true });

  return mkdtempSync(join(parent, "readmodel-"));
}
