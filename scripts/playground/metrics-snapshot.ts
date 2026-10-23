import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { state } from "./config.js";

export async function diagnosticPath(path: string, directory = resolve(state, "diagnostics")) {
  const canonical = await realpath(path);
  const diagnostics = await realpath(directory);

  if (
    diagnostics !== resolve(directory) ||
    !canonical.startsWith(`${diagnostics}${sep}`) ||
    !(await stat(canonical)).isFile()
  ) {
    throw new Error(
      "Open only a copied SQLite snapshot under the selected playground diagnostics.",
    );
  }

  return canonical;
}

const approvalSchema = z.strictObject({
  profile: z.literal("architecture"),
  sourceClosed: z.literal(true),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  batch: z.string(),
});

export async function approvedDiagnostic(path: string, approvalPath: string, batch: string) {
  const approval = approvalSchema.parse(JSON.parse(await readFile(approvalPath, "utf8")));

  const hash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

  if (approval.path !== path || approval.batch !== batch || approval.sha256 !== hash) {
    throw new Error(
      "Closed-copy approval must match this profile's snapshot path, batch and hash.",
    );
  }

  return hash;
}
