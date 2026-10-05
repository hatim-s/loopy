import type { RuntimeIdentity } from "../application/ports.js";

/** Publishing accepts declared UTF-8 source files only. It never scans a directory. */
export type PublishManifest = {
  readonly entrypoint: string;
  readonly files: readonly string[];
  readonly sources: readonly { readonly source: string; readonly target: string }[];
  readonly lockfile: string;
  readonly compiler: string;
  readonly runtime: RuntimeIdentity;
};
export type BundleLimits = {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxBundleBytes: number;
};
export const defaultBundleLimits: BundleLimits = {
  maxFiles: 100,
  maxFileBytes: 1024 * 1024,
  maxBundleBytes: 10 * 1024 * 1024,
};
export type BundleFile = {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
};
export type PublishBundle = {
  readonly manifest: PublishManifest;
  readonly files: readonly BundleFile[];
  readonly lockfileHash: string;
  readonly sha256: string;
  readonly bytes: number;
};

export function normalizeBundlePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    /[:#?%]/.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    value.startsWith("/")
  ) {
    throw new Error(`Invalid bundle path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "..")) throw new Error(`Bundle path traversal: ${value}`);
  const normalized = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (!normalized) throw new Error(`Invalid bundle path: ${value}`);
  return normalized;
}

export async function hashContent(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The caller reads exactly these files. Bytes are validated before compilation or upload. */
export async function preparePublishBundle(
  manifest: PublishManifest,
  readFile: (path: string) => Promise<Uint8Array>,
  limits: BundleLimits = defaultBundleLimits,
): Promise<PublishBundle> {
  for (const limit of Object.values(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Bundle limits must be positive integers");
  }
  if (
    !manifest.compiler.trim() ||
    !manifest.runtime.build.trim() ||
    manifest.runtime.graphSchema !== 1
  ) {
    throw new Error("Publishing requires compiler and runtime identities");
  }
  if (manifest.files.length === 0 || manifest.files.length > limits.maxFiles)
    throw new Error("Bundle file count exceeds limits");
  const paths = manifest.files.map(normalizeBundlePath).sort();
  const declared = new Set(paths);
  if (declared.size !== paths.length) throw new Error("Duplicate bundle file paths");
  const entrypoint = normalizeBundlePath(manifest.entrypoint);
  const lockfile = normalizeBundlePath(manifest.lockfile);
  if (!declared.has(entrypoint) || !declared.has(lockfile))
    throw new Error("Entrypoint and lockfile must be declared files");
  const sources = manifest.sources
    .map(({ source, target }) => ({
      source: normalizeBundlePath(source),
      target: normalizeBundlePath(target),
    }))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  if (
    new Set(sources.map(({ source }) => source)).size !== sources.length ||
    new Set(sources.map(({ target }) => target)).size !== sources.length
  )
    throw new Error("Duplicate source mapping");
  if (sources.some(({ target }) => !declared.has(target)))
    throw new Error("Source mapping target must be a declared file");
  const normalized: PublishManifest = {
    entrypoint,
    files: paths,
    sources,
    lockfile,
    compiler: manifest.compiler,
    runtime: { build: manifest.runtime.build, graphSchema: 1 },
  };
  const files: BundleFile[] = [];
  let bytes = 0;
  for (const path of paths) {
    const contentBytes = await readFile(path);
    bytes += contentBytes.byteLength;
    if (contentBytes.byteLength > limits.maxFileBytes || bytes > limits.maxBundleBytes)
      throw new Error("Bundle byte limit exceeded");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contentBytes);
    } catch {
      throw new Error(`Bundle file must be UTF-8: ${path}`);
    }
    if (content.includes("\0")) throw new Error(`Binary bundle file is unsupported: ${path}`);
    files.push({
      path,
      content,
      bytes: contentBytes.byteLength,
      sha256: await hashContent(contentBytes),
    });
  }
  const lockfileHash = files.find((file) => file.path === lockfile)?.sha256;
  if (!lockfileHash) throw new Error("Missing lockfile");
  const identity = JSON.stringify({
    manifest: normalized,
    files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
  });
  return {
    manifest: normalized,
    files,
    lockfileHash,
    bytes,
    sha256: await hashContent(new TextEncoder().encode(identity)),
  };
}

/** Recompute received content identities before accepting a prepared bundle. */
export async function verifyPublishBundle(
  bundle: PublishBundle,
  limits: BundleLimits = defaultBundleLimits,
): Promise<PublishBundle> {
  const incoming = new Map(bundle.files.map((file) => [file.path, file]));
  if (
    incoming.size !== bundle.files.length ||
    bundle.files.length !== bundle.manifest.files.length
  ) {
    throw new Error("Bundle files must exactly match the manifest");
  }
  const verified = await preparePublishBundle(
    bundle.manifest,
    async (path) => {
      const file = incoming.get(path);
      if (!file) throw new Error(`Missing bundle file: ${path}`);
      return new TextEncoder().encode(file.content);
    },
    limits,
  );
  for (const file of verified.files) {
    const received = incoming.get(file.path);
    if (received?.sha256 !== file.sha256 || received.bytes !== file.bytes) {
      throw new Error(`Bundle file identity mismatch: ${file.path}`);
    }
  }
  if (
    verified.sha256 !== bundle.sha256 ||
    verified.lockfileHash !== bundle.lockfileHash ||
    verified.bytes !== bundle.bytes
  ) {
    throw new Error("Bundle identity mismatch");
  }
  return verified;
}
