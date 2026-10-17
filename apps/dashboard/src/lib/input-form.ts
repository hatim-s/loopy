import { type Json, jsonSchema, type LoopyView } from "loopy/contract";

export type RecordSpec = Exclude<LoopyView["input"], "schema">;

export type InputField = {
  key: string;
  kind: RecordSpec[string];
  optional: boolean;
};

/** Every field holds the text of its control; booleans are "true", "false" or "" for unset. */
export type FieldValues = Record<string, string>;

export type FieldIssue = { key: string; message: string };

export type Coerced = { valid: true; value: Json } | { valid: false; issues: FieldIssue[] };

/** A key ending in "?" is optional; the input object uses the key without it. */
export function inputFields(spec: RecordSpec): InputField[] {
  return Object.entries(spec).map(([field, kind]) => {
    const optional = field.endsWith("?");

    return { key: optional ? field.slice(0, -1) : field, kind, optional };
  });
}

/** Required booleans start false so the form is submittable without touching them. */
export function initialValues(fields: InputField[]): FieldValues {
  return Object.fromEntries(
    fields.map((field) => [field.key, field.kind === "boolean" && !field.optional ? "false" : ""]),
  );
}

type FieldResult = { valid: true; value: Json } | { valid: false; message: string };

function coerceField(kind: InputField["kind"], text: string): FieldResult {
  switch (kind) {
    case "json": {
      const parsed = parseJsonInput(text);

      return parsed.valid ? parsed : { valid: false, message: "Enter valid JSON." };
    }

    case "string": {
      return { valid: true, value: text };
    }

    case "number": {
      const value = Number(text.trim());

      return Number.isFinite(value)
        ? { valid: true, value }
        : { valid: false, message: "Enter a number." };
    }

    case "boolean": {
      return { valid: true, value: text === "true" };
    }
  }
}

/**
 * Turns form text into the JSON the server validates against the spec. An empty optional
 * field is left out of the object; an empty required one is an issue.
 */
export function coerceInput(fields: InputField[], values: FieldValues): Coerced {
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

    const coerced = coerceField(field.kind, text);

    if (coerced.valid) {
      entries.push([field.key, coerced.value]);
    } else {
      issues.push({ key: field.key, message: coerced.message });
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
    return { valid: true, value: jsonSchema.parse(JSON.parse(text)) };
  } catch {
    return { valid: false };
  }
}
