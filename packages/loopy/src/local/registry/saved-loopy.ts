import {
  isStringArray,
  requireOneOf,
  requireRecord,
  requireString,
  setOwnProperty,
  validateSlug,
} from "../../core/index.js";
import { parseCron } from "../../runtime/index.js";
import type { Loopy, RecordSpec } from "../../sdk/index.js";

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

// BOUNDARY: A registry schedule is untyped JSON until its cron and zone are checked.
function scheduleSummary(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  const schedule = requireRecord(value, "Saved schedule");
  const cron = requireString(schedule.cron, "Schedule cron");
  parseCron(cron);

  const tz =
    schedule.tz === undefined ? undefined : requireString(schedule.tz, "Schedule timezone");

  if (tz !== undefined) {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  }

  return { cron, tz };
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
    schedule: scheduleSummary(value.schedule),
    mode: requireOneOf(value.mode, ["sandbox", "full"], "mode"),
    secrets: value.secrets,
    savedAt: requireString(value.savedAt, "saved at"),
  };
}
