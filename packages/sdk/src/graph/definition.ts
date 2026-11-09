import {
  allowKeys,
  DEFAULT_TIME_ZONE,
  EXECUTION_MODES,
  FIELD_TYPES,
  type GraphMeta,
  isStringArray,
  LOOPY_SCOPES,
  type RecordSpec,
  requireOneOf,
  requireRecord,
  requireString,
  validateSchedule,
  validateSecretName,
  validateSlug,
} from "@loopy/core";
import type { LoopyDefinition } from "./loopy";

const DEFINITION_KEYS = Object.keys({
  description: true,
  schedule: true,
  secrets: true,
  mode: true,
  scope: true,
  input: true,
  inputValidation: true,
  run: true,
} satisfies Record<keyof LoopyDefinition<RecordSpec>, true>);

// BOUNDARY: JavaScript author modules can pass malformed field schemas to the public builder.
export function parseDefinitionInput(value: unknown) {
  return Object.fromEntries(
    Object.entries(requireRecord(value, "Input schema")).map(([key, type]) => [
      key,
      requireOneOf(type, FIELD_TYPES, `Input field '${key}'`),
    ]),
  );
}

// BOUNDARY: JavaScript author definitions need validation before their metadata enters a graph.
export function parseDefinitionMeta(name: string, value: unknown) {
  validateSlug(name);
  const definition = requireRecord(value, "Loopy definition");
  allowKeys(definition, "Loopy definition", DEFINITION_KEYS);
  const secrets = definition.secrets ?? [];

  if (!isStringArray(secrets)) {
    throw new Error("Secrets must be a list of strings. Supply the secret names to expose.");
  }

  secrets.forEach(validateSecretName);

  return {
    description:
      definition.description === undefined
        ? null
        : requireString(definition.description, "Description"),
    schedule:
      definition.schedule === undefined
        ? null
        : parseSchedule(requireRecord(definition.schedule, "Schedule")),
    secrets: [...secrets],
    mode: requireOneOf(definition.mode ?? "sandbox", EXECUTION_MODES, "Loopy mode"),
    scope: requireOneOf(definition.scope ?? "project", LOOPY_SCOPES, "Loopy scope"),
  };
}

// BOUNDARY: A validated object still contains untyped schedule fields from the author module.
function parseSchedule(schedule: Record<string, unknown>): NonNullable<GraphMeta["schedule"]> {
  allowKeys(schedule, "Schedule", ["cron", "tz"]);

  const parsed = {
    cron: requireString(schedule.cron, "Schedule cron"),
    tz:
      schedule.tz === undefined
        ? DEFAULT_TIME_ZONE
        : requireString(schedule.tz, "Schedule timezone"),
  };

  validateSchedule(parsed);

  return parsed;
}
