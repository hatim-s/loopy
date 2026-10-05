import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  defaultBundleLimits,
  type PublishBundle,
  type PublishManifest,
  preparePublishBundle,
} from "../publishing/manifest.js";
import { manifestReader } from "./publishing-reader.js";

export async function prepareManifestFile(file: string): Promise<PublishBundle> {
  const manifestPath = await realpath(resolve(file));
  const root = dirname(manifestPath);
  const reader = await manifestReader(root);
  try {
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        reader.read(basename(manifestPath), defaultBundleLimits.maxFileBytes),
      ),
    );
    if (!raw || typeof raw !== "object") throw new Error("Invalid publishing manifest");
    const value = raw as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          !["entrypoint", "files", "sources", "lockfile", "compiler", "runtime"].includes(key),
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
    return await preparePublishBundle(value as PublishManifest, async (path) =>
      reader.read(path, defaultBundleLimits.maxFileBytes),
    );
  } finally {
    reader.close();
  }
}
