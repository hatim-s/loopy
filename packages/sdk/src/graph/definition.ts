import {
  authorMetaSchema,
  FIELD_TYPES,
  inputValidationIssue,
  inputValidationSchema,
  type RecordSpec,
  validateSchedule,
  validateSecretName,
  validateSlug,
} from "@loopy/core";
import { Result, Schema, SchemaIssue } from "effect";
import type { LoopyDefinition } from "./loopy";

const definitionFields = {
  ...authorMetaSchema.fields,
  // The builder reports reserved field names with its own label rule.
  input: Schema.Record(Schema.String, Schema.Literals(FIELD_TYPES)),
  inputValidation: Schema.optional(inputValidationSchema),
  run: Schema.Unknown,
} satisfies Record<keyof LoopyDefinition<RecordSpec>, Schema.Constraint>;

const definitionSchema = Schema.Struct(definitionFields);

const decodeDefinition = Schema.decodeUnknownResult(definitionSchema, {
  onExcessProperty: "error",
});

const formatIssue = SchemaIssue.makeFormatterDefault();

// BOUNDARY: JavaScript author definitions need validation before their metadata enters a graph.
export function parseDefinition(name: string, value: unknown) {
  validateSlug(name);
  const decoded = decodeDefinition(value);

  if (Result.isFailure(decoded)) {
    throw new Error(`Loopy definition '${name}' is invalid: ${formatIssue(decoded.failure.issue)}`);
  }

  const { input, inputValidation, description, schedule, secrets, mode, scope } = decoded.success;
  secrets.forEach(validateSecretName);

  if (schedule !== null) {
    validateSchedule(schedule);
  }

  const issue = inputValidation && inputValidationIssue(inputValidation, input);

  if (issue) {
    throw new Error(issue);
  }

  return {
    input,
    inputValidation,
    meta: { description, schedule, secrets: [...secrets], mode, scope },
  };
}
