import { type Graph, type InputValidation, UNKNOWN_KEY_MODES } from "./graph";
import { elementType, type RecordSpec } from "./graph/values";
import type { Json } from "./json";
import { matchesRecordSpec, recordField, recordFields } from "./record-spec";
import { isNumber, isRecord, requireOneOf, requireRecord } from "./validation";

function minimumIssue(key: string) {
  return `Input minimum '${key}' requires an array field and a nonnegative integer.`;
}

/** Checks the rules a decoded validation must meet against its record fields. */
export function inputValidationIssue(validation: InputValidation, fields: RecordSpec) {
  for (const [key, minimum] of Object.entries(validation.minItems)) {
    if (
      elementType(recordField(fields, key) ?? null) === null ||
      !Number.isSafeInteger(minimum) ||
      minimum < 0
    ) {
      return minimumIssue(key);
    }
  }

  if (
    validation.root === "json" &&
    (validation.unknownKeys !== "passthrough" ||
      Object.keys(validation.minItems).length > 0 ||
      recordFields(fields).some(({ optional, kind }) => !optional || kind !== "json"))
  ) {
    return "JSON input roots require passthrough, optional JSON field hints and no array constraints.";
  }

  return null;
}

// BOUNDARY: JavaScript builders can supply untyped validation options.
export function parseInputValidation(value: unknown, fields: RecordSpec) {
  if (value === undefined) {
    return undefined;
  }

  const options = requireRecord(value, "Input validation");

  if (Object.keys(options).some((key) => !["minItems", "unknownKeys", "root"].includes(key))) {
    throw new Error("Input validation accepts minItems, unknownKeys and root only.");
  }

  const unknownKeys = requireOneOf(options.unknownKeys, UNKNOWN_KEY_MODES, "Unknown input keys");

  const minItems = Object.entries(requireRecord(options.minItems, "Input array minimums")).map(
    ([key, minimum]) => {
      if (!isNumber(minimum)) {
        throw new Error(minimumIssue(key));
      }

      return [key, minimum] as const;
    },
  );

  const validation: InputValidation = {
    minItems: Object.fromEntries(minItems),
    unknownKeys,
    root:
      options.root === undefined
        ? undefined
        : requireOneOf(options.root, ["json"] as const, "Input root"),
  };

  const issue = inputValidationIssue(validation, fields);

  if (issue !== null) {
    throw new Error(issue);
  }

  return validation;
}

export function validateGraphInput(graph: Pick<Graph, "input" | "inputValidation">, input: Json) {
  const spec = graph.input;

  if (graph.inputValidation?.root === "json") {
    return { ok: true as const, value: input };
  }

  if (spec === "schema" || !isRecord(input)) {
    return { ok: false as const, error: "Graph input requires a record schema and an object." };
  }

  const fields = recordFields(spec);

  if (
    ((graph.inputValidation?.unknownKeys ?? "reject") === "reject" &&
      Object.keys(input).some((key) => !fields.some((field) => field.key === key))) ||
    !matchesRecordSpec(input, spec) ||
    Object.entries(graph.inputValidation?.minItems ?? {}).some(([key, minimum]) => {
      const value = input[key];

      return value !== undefined && (!Array.isArray(value) || value.length < minimum);
    })
  ) {
    return { ok: false as const, error: "Input does not match the saved graph schema." };
  }

  return {
    ok: true as const,
    value:
      graph.inputValidation?.unknownKeys === "strip"
        ? Object.fromEntries(
            Object.entries(input).filter(([key]) => fields.some((field) => field.key === key)),
          )
        : input,
  };
}
