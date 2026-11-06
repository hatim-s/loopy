import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { root } from "./config";

export async function runtimeSource() {
  const directory = join(root, "packages/loopy/src");

  const files = await Array.fromAsync(
    new Bun.Glob("**/*.ts").scan({ cwd: directory, absolute: true }),
  );

  const hash = createHash("sha256");

  for (const file of files.sort()) {
    hash.update(`${relative(directory, file)}\0`);
    hash.update(await readFile(file));
  }

  return {
    observedAt: new Date().toISOString(),
    files: files.length,
    sha256: hash.digest("hex"),
    queryRunsSha256: createHash("sha256")
      .update(await readFile(join(directory, "store/sqlite/query-runs.ts")))
      .digest("hex"),
  };
}
