import { isFieldValue } from "./field-value.js";
import type { Graph, InputValidation, RecordSpec } from "./graph.js";
import type { Json } from "./model.js";
import { isNumber, isRecord, requireOneOf, requireRecord } from "./validation.js";

// BOUNDARY: JavaScript builders can supply untyped validation options.
export function parseInputValidation(value: unknown, fields: RecordSpec) {
  if (value === undefined) {
    return undefined;
  }

  const options = requireRecord(value, "Input validation");

  if (Object.keys(options).some((key) => !["minItems", "unknownKeys", "root"].includes(key))) {
    throw new Error("Input validation accepts minItems, unknownKeys and root only.");
  }

  const unknownKeys = requireOneOf(
    options.unknownKeys,
    ["strip", "reject", "passthrough"] as const,
    "Unknown input keys",
  );

  const minItems = Object.fromEntries(
    Object.entries(requireRecord(options.minItems, "Input array minimums")).map(
      ([key, minimum]) => {
        const field = fields[key] ?? fields[`${key}?`];

        if (
          !field?.endsWith("[]") ||
          !isNumber(minimum) ||
          !Number.isSafeInteger(minimum) ||
          minimum < 0
        ) {
          throw new Error(
            `Input minimum '${key}' requires an array field and a nonnegative integer.`,
          );
        }

        return [key, minimum];
      },
    ),
  );

  const root =
    options.root === undefined
      ? undefined
      : requireOneOf(options.root, ["json"] as const, "Input root");

  if (
    root === "json" &&
    (unknownKeys !== "passthrough" ||
      Object.keys(minItems).length > 0 ||
      Object.entries(fields).some(([key, type]) => !key.endsWith("?") || type !== "json"))
  ) {
    throw new Error(
      "JSON input roots require passthrough, optional JSON field hints and no array constraints.",
    );
  }

  return { minItems, unknownKeys, root } satisfies InputValidation;
}

export function validateGraphInput(graph: Pick<Graph, "input" | "inputValidation">, input: Json) {
  const spec = graph.input;

  if (graph.inputValidation?.root === "json") {
    return { ok: true as const, value: input };
  }

  if (spec === "schema" || !isRecord(input)) {
    return { ok: false as const, error: "Graph input requires a record schema and an object." };
  }

  const fields = Object.entries(spec).map(([field, kind]) => ({
    key: field.replace(/\?$/, ""),
    optional: field.endsWith("?"),
    kind,
  }));

  if (
    ((graph.inputValidation?.unknownKeys ?? "reject") === "reject" &&
      Object.keys(input).some((key) => !fields.some((field) => field.key === key))) ||
    fields.some(
      ({ key, optional, kind }) =>
        !(optional && input[key] === undefined) && !isFieldValue(kind, input[key]),
    ) ||
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
