import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256Hex } from "../shared/hash";
import { root } from "../stack/constants";

export async function runtimeSource() {
  const directory = join(root, "packages");

  const files = await Array.fromAsync(
    new Bun.Glob("*/src/**/*.ts").scan({ cwd: directory, absolute: true }),
  );

  const parts: Uint8Array[] = [];

  for (const file of files.sort()) {
    parts.push(new TextEncoder().encode(`${relative(directory, file)}\0`), await readFile(file));
  }

  return {
    observedAt: new Date().toISOString(),
    files: files.length,
    sha256: sha256Hex(Buffer.concat(parts)),
  };
}
