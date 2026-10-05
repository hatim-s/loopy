import { open, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  defaultBundleLimits,
  type PublishBundle,
  type PublishManifest,
  preparePublishBundle,
} from "../publishing/manifest.js";

export async function prepareManifestFile(file: string): Promise<PublishBundle> {
  const manifestPath = await realpath(resolve(file));
  const root = dirname(manifestPath);
  async function readBounded(path: string, limit: number): Promise<Uint8Array> {
    const actual = await realpath(path);
    const fromRoot = relative(root, actual);
    if (fromRoot === ".." || fromRoot.startsWith("../"))
      throw new Error("Declared file resolves outside the manifest directory");
    const handle = await open(actual, "r");
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Publishing requires regular files");
      const bytes = new Uint8Array(limit + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await handle.read(bytes, count, bytes.length - count, null);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      if (count > limit) throw new Error("Publishing file exceeds byte limits");
      return bytes.slice(0, count);
    } finally {
      await handle.close();
    }
  }
  const raw: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readBounded(manifestPath, defaultBundleLimits.maxFileBytes),
    ),
  );
  if (!raw || typeof raw !== "object") throw new Error("Invalid publishing manifest");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["entrypoint", "files", "sources", "lockfile", "compiler", "runtime"].includes(key),
    ) ||
    typeof value.entrypoint !== "string" ||
    typeof value.lockfile !== "string" ||
    typeof value.compiler !== "string" ||
    !Array.isArray(value.files) ||
    !value.files.every((path) => typeof path === "string") ||
    !Array.isArray(value.sources) ||
    !value.sources.every(
      (mapping) =>
        mapping &&
        typeof mapping === "object" &&
        Object.keys(mapping).every((key) => key === "source" || key === "target") &&
        typeof mapping.source === "string" &&
        typeof mapping.target === "string",
    ) ||
    !value.runtime ||
    typeof value.runtime !== "object" ||
    typeof (value.runtime as Record<string, unknown>).build !== "string" ||
    (value.runtime as Record<string, unknown>).graphSchema !== 1 ||
    Object.keys(value.runtime).some((key) => key !== "build" && key !== "graphSchema")
  )
    throw new Error("Invalid publishing manifest");
  return preparePublishBundle(value as PublishManifest, (path) =>
    readBounded(resolve(root, path), defaultBundleLimits.maxFileBytes),
  );
}
