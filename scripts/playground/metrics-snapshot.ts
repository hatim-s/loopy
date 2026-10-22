import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { state } from "./config.js";

export async function diagnosticPath(path: string) {
  const canonical = await realpath(path);
  const diagnostics = await realpath(resolve(state, "diagnostics"));

  if (!canonical.startsWith(`${diagnostics}${sep}`) || !(await stat(canonical)).isFile()) {
    throw new Error("Open only a copied SQLite snapshot under playground diagnostics.");
  }

  return canonical;
}
