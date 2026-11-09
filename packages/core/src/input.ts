import type { Graph, InputValidation } from "./graph";
import { elementType, type RecordSpec } from "./graph/values";
import type { Json } from "./json";
import { matchesRecordSpec, recordField, recordFields } from "./record-spec";
import { isRecord } from "./validation";

// A decoded validation must also agree with the record fields it constrains.
export function inputValidationIssue(validation: InputValidation, fields: RecordSpec) {
  for (const key of Object.keys(validation.minItems)) {
    if (elementType(recordField(fields, key) ?? null) === null) {
      return `Input minimum '${key}' requires an array field.`;
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
