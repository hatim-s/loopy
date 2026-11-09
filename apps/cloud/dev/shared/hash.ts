import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function sha256Hex(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export async function sourceHashes(root: string, paths: readonly string[]) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(
        async (path) =>
          [
            path,
            sha256Hex(new Uint8Array(await Bun.file(resolve(root, path)).arrayBuffer())),
          ] as const,
      ),
    ),
  );
}
