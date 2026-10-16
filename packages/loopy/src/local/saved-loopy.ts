import {
  isStringArray,
  requireOneOf,
  requireRecord,
  requireString,
  setOwnProperty,
  validateSlug,
} from "../core/index.js";
import { type Loopy, parseSchedule, type RecordSpec } from "../sdk/host.js";

export type SavedLoopy = {
  slug: string;
  scope: "project" | "global";
  bundleHash: string;
  source: string;
  description?: string;
  input: RecordSpec | "schema";
  schedule?: Loopy["schedule"];
  mode: Loopy["mode"];
  secrets: readonly string[];
  savedAt: string;
};

// BOUNDARY: Registry metadata is JSON read from disk.
function inputSummary(value: unknown) {
  if (value === "schema") {
    return value;
  }

  const spec = requireRecord(value, "Saved input summary");
  const fields: RecordSpec = {};

  for (const [key, kind] of Object.entries(spec)) {
    setOwnProperty(fields, key, requireOneOf(kind, ["string", "number", "boolean"], "Input kind"));
  }

  return fields;
}

// BOUNDARY: Registry entries are validated once when their JSON is read.
export function parseSavedLoopy(input: unknown): SavedLoopy {
  const value = requireRecord(input, "Saved loopy");
  const slug = requireString(value.slug, "slug");
  validateSlug(slug);

  if (!isStringArray(value.secrets)) {
    throw new Error("Saved secrets must be names. Save the loopy again.");
  }

  return {
    slug,
    scope: requireOneOf(value.scope, ["project", "global"], "scope"),
    bundleHash: requireString(value.bundleHash, "bundle hash"),
    source: requireString(value.source, "source"),
    description:
      value.description === undefined ? undefined : requireString(value.description, "description"),
    input: inputSummary(value.input),
    schedule: parseSchedule(value.schedule),
    mode: requireOneOf(value.mode, ["sandbox", "full"], "mode"),
    secrets: value.secrets,
    savedAt: requireString(value.savedAt, "saved at"),
  };
}
