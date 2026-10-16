import { isAbsolute } from "node:path";

export const script = "scripts/platform-feature-assets/sync-t2w-assets.mjs";

const defaults = {
  feature: "ai-agents",
  indexPath: "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
  baseBranch: "main",
  branchPrefix: "loopy/uacode-asset-sync",
  prTitle: "Sync exported T2W assets",
  exportDirectory: "",
  dryRun: false,
};

type Asset = { assetClass: string; assetId: string; assetVersion?: string };

export type Request = typeof defaults & { assets: Asset[]; repository: string };

// BOUNDARY: Agent request fields must be nonempty strings without control characters.
function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error(`${name} must be a non-empty string without control characters`);
  }

  return value;
}

// BOUNDARY: Agent requests and summary JSON must be non-null objects before their allowed fields are validated.
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }

  // SAFETY: The check above establishes a non-null, non-array object; each selected field remains unknown until validated.
  return value as Record<string, unknown>;
}

// BOUNDARY: Agent request JSON is checked for allowed keys, asset identities, repository and safe path options.
export function parseRequest(raw: unknown): Request {
  const input = object(raw);
  const allowed = new Set(["assets", "repository", ...Object.keys(defaults)]);

  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
  }

  if (!Array.isArray(input.assets) || !input.assets.length) {
    throw new Error("assets must be a non-empty array");
  }

  const assets = input.assets.map(parseAsset);

  const options = { ...defaults, ...input };
  const { feature, indexPath } = parseOptions(options);

  return {
    assets,
    repository: absolutePath(input.repository, "repository"),
    feature,
    indexPath,
    baseBranch: text(options.baseBranch, "baseBranch"),
    branchPrefix: text(options.branchPrefix, "branchPrefix"),
    prTitle: text(options.prTitle, "prTitle"),
    exportDirectory: options.exportDirectory
      ? absolutePath(options.exportDirectory, "exportDirectory")
      : "",
    dryRun: options.dryRun,
  };
}

// BOUNDARY: Each untrusted asset entry needs a class, identity and optional version.
function parseAsset(value: unknown, i: number): Asset {
  const item = object(value);

  if (Object.keys(item).some((key) => !["assetClass", "assetId", "assetVersion"].includes(key))) {
    throw new Error(`Unknown assets[${i}] field`);
  }

  const asset: Asset = {
    assetClass: text(item.assetClass, `assets[${i}].assetClass`),
    assetId: text(item.assetId, `assets[${i}].assetId`),
  };

  if (item.assetVersion !== undefined) {
    asset.assetVersion = text(item.assetVersion, `assets[${i}].assetVersion`);
  }

  return asset;
}

// BOUNDARY: Request paths must be absolute so bundles do not depend on their execution cwd.
function absolutePath(value: unknown, name: string) {
  const path = text(value, name);

  if (!isAbsolute(path)) {
    throw new Error(`${name} must be absolute.`);
  }

  return path;
}

// BOUNDARY: Request options constrain the feature, index path and primitive option types.
function parseOptions(options: Record<string, unknown>) {
  const feature = text(options.feature, "feature");

  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error("feature must be one directory name");
  }

  const indexPath = text(options.indexPath, "indexPath");

  if (
    isAbsolute(indexPath) ||
    indexPath.includes("\\") ||
    indexPath.split("/").some((part) => !part || part === "." || part === "..") ||
    !indexPath.startsWith(`configs/platform-features/${feature}/`) ||
    !indexPath.endsWith(".json")
  ) {
    throw new Error(
      "indexPath must be a repository-relative JSON path within the selected feature",
    );
  }

  if (typeof options.dryRun !== "boolean") {
    throw new Error("dryRun must be a boolean");
  }

  if (typeof options.exportDirectory !== "string") {
    throw new Error("exportDirectory must be a string");
  }

  return { feature, indexPath };
}
