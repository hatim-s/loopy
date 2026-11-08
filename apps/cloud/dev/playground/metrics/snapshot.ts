import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { within } from "../../../../../packages/runtime/src/local/sandbox/paths";
import { sha256Hex } from "../../shared/hash";

export async function diagnosticPath(path: string, directory: string) {
  const canonical = await realpath(path);
  const diagnostics = await realpath(directory);

  if (
    diagnostics !== resolve(directory) ||
    canonical === diagnostics ||
    !within(diagnostics, canonical) ||
    !(await stat(canonical)).isFile()
  ) {
    throw new Error(
      "Open only a copied SQLite snapshot under the selected playground diagnostics.",
    );
  }

  return canonical;
}

const approvalSchema = Schema.Struct({
  profile: Schema.Literals(["default", "architecture"]),
  sourceClosed: Schema.Literal(true),
  path: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  batch: Schema.String,
});

// The owner records a closed copy's path and hash before any SQL evidence is taken from it.
export async function approvedDiagnostic(options: {
  path: string;
  approvalPath: string;
  batch: string;
  profile: "default" | "architecture";
}) {
  const approval = decodeBoundary(approvalSchema)(
    JSON.parse(await readFile(options.approvalPath, "utf8")),
  );

  const hash = sha256Hex(await readFile(options.path));

  if (
    approval.profile !== options.profile ||
    approval.path !== options.path ||
    approval.batch !== options.batch ||
    approval.sha256 !== hash
  ) {
    throw new Error(
      "Closed-copy approval must match this profile's snapshot path, batch and hash.",
    );
  }

  return hash;
}
