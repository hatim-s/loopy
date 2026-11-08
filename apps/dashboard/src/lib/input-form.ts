import {
  decodeJson,
  type Json,
  jsonSchema,
  type LoopyView,
  parseFieldText,
  type RecordField,
} from "@loopy/contract";

export type RecordSpec = Exclude<LoopyView["input"], "schema">;

/** Every field holds the text of its control; booleans are "true", "false" or "" for unset. */
export type FieldValues = Record<string, string>;

export type FieldIssue = { key: string; message: string };

export type Coerced = { valid: true; value: Json } | { valid: false; issues: FieldIssue[] };

/** Required booleans start false so the form is submittable without touching them. */
export function initialValues(fields: RecordField[]): FieldValues {
  return Object.fromEntries(
    fields.map((field) => [field.key, field.kind === "boolean" && !field.optional ? "false" : ""]),
  );
}

function fieldIssue(kind: RecordField["kind"], reason: "json" | "kind"): string {
  if (reason === "json") {
    return "Enter valid JSON.";
  }

  switch (kind) {
    case "string":
    case "number":
      return `Enter a ${kind}.`;
    case "boolean":
      return "Choose true or false.";
    default:
      return `Enter a ${kind} as JSON.`;
  }
}

/**
 * Turns form text into the JSON the server validates against the spec. An empty optional
 * field is left out of the object; an empty required one is an issue.
 */
export function coerceInput(fields: RecordField[], values: FieldValues): Coerced {
  const entries: [string, Json][] = [];
  const issues: FieldIssue[] = [];

  for (const field of fields) {
    const text = values[field.key] ?? "";

    if (text.trim() === "") {
      if (!field.optional) {
        issues.push({ key: field.key, message: "Required." });
      }

      continue;
    }

    const parsed = parseFieldText(field.kind, text);

    if (parsed.ok) {
      entries.push([field.key, parsed.value]);
    } else {
      issues.push({ key: field.key, message: fieldIssue(field.kind, parsed.reason) });
    }
  }

  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value: Object.fromEntries(entries) };
}

export type ParsedJson = { valid: true; value: Json } | { valid: false };

/** Editor text for a loopy whose input is a schema; the server checks it against the schema. */
export function parseJsonInput(text: string): ParsedJson {
  try {
    return { valid: true, value: decodeJson(jsonSchema)(text) };
  } catch {
    return { valid: false };
  }
}
