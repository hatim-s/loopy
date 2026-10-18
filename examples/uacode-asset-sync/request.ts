import { isAbsolute } from "node:path";

export const script = "scripts/platform-feature-assets/sync-t2w-assets.mjs";

const defaults = {
  feature: "ai-agents",
  indexPath: "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
  base: "main",
  branchPrefix: "loopy/uacode-asset-sync",
  prTitle: "Sync exported T2W assets",
  exportDirectory: "",
};

// BOUNDARY: Request JSON objects keep fields unknown until schema validation.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !/[\x00-\x1f]/.test(value);
}

// BOUNDARY: Request string fields must be nonempty and exclude control characters.
function field(input: Record<string, unknown>, key: string, fallback?: string) {
  const value = input[key] === undefined ? fallback : input[key];

  if (!isSafeText(value)) {
    throw new Error(
      `${key} must be a nonempty string without control characters. Correct the input.`,
    );
  }

  return value;
}

type Asset = { assetClass: string; assetId: string; assetVersion?: string };

// BOUNDARY: Asset identities come from the request JSON array.
function asset(value: unknown): Asset {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["assetClass", "assetId", "assetVersion"].includes(key))
  ) {
    throw new Error("Invalid asset object. Supply assetClass, assetId and optional assetVersion.");
  }

  const result: Asset = {
    assetClass: field(value, "assetClass"),
    assetId: field(value, "assetId"),
  };

  if (value.assetVersion !== undefined) {
    result.assetVersion = field(value, "assetVersion");
  }

  return result;
}

// BOUNDARY: The Standard Schema owns request validation, defaults and its inferred output type.
function requestInput(input: unknown) {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => !["repository", "assets", "dryRun", ...Object.keys(defaults)].includes(key),
    )
  ) {
    throw new Error("Invalid request fields. Supply repository, assets and supported options.");
  }

  if (!Array.isArray(input.assets) || !input.assets.length) {
    throw new Error("assets must be a nonempty array. Pass real assets with --input-json.");
  }

  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
    throw new Error("dryRun must be a boolean. Supply true or false.");
  }

  return { fields: input, assets: input.assets.map(asset), dryRun: input.dryRun ?? false };
}

// BOUNDARY: Request paths and options refine the schema's primitive fields.
function validateRequest(value: unknown) {
  const input = requestInput(value);
  const repository = field(input.fields, "repository");

  const exportDirectory =
    input.fields.exportDirectory === undefined || input.fields.exportDirectory === ""
      ? ""
      : field(input.fields, "exportDirectory");

  const feature = field(input.fields, "feature", defaults.feature);
  const indexPath = field(input.fields, "indexPath", defaults.indexPath);
  validatePaths({ repository, exportDirectory, feature, indexPath });

  if (input.dryRun && !exportDirectory) {
    throw new Error("Supply an extracted exportDirectory for a read-only preview.");
  }

  return {
    repository,
    exportDirectory,
    feature,
    indexPath,
    assets: input.assets,
    dryRun: input.dryRun,
    base: field(input.fields, "base", defaults.base),
    branchPrefix: field(input.fields, "branchPrefix", defaults.branchPrefix),
    prTitle: field(input.fields, "prTitle", defaults.prTitle),
  };
}

function validatePaths(input: {
  repository: string;
  exportDirectory: string;
  feature: string;
  indexPath: string;
}) {
  const { repository, exportDirectory, feature, indexPath } = input;

  if (!isAbsolute(repository) || (exportDirectory && !isAbsolute(exportDirectory))) {
    throw new Error("Repository and exportDirectory must be absolute. Supply full paths.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error("feature must be one directory name. Remove separators and unsafe characters.");
  }

  if (
    !/^[a-zA-Z0-9_./@-]+$/.test(indexPath) ||
    indexPath.split("/").some((part) => !part || part === "." || part === "..") ||
    !indexPath.startsWith(`configs/platform-features/${feature}/`) ||
    !indexPath.endsWith(".json")
  ) {
    throw new Error(
      "indexPath must be a relative JSON path within the selected feature. Correct the path.",
    );
  }
}

export const requestSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "loopy-asset-sync",
    // BOUNDARY: Standard Schema receives untyped CLI JSON and returns issues before commands run.
    validate(value: unknown) {
      try {
        return { value: validateRequest(value) };
      } catch (cause) {
        return {
          issues: [
            {
              message:
                cause instanceof Error ? cause.message : "Invalid request. Correct the input.",
            },
          ],
        };
      }
    },
  },
};

export type Request = ReturnType<typeof validateRequest>;
