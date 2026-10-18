import {
  assertTimeZone,
  EXECUTION_MODES,
  FIELD_TYPES,
  type GraphMeta,
  LOOPY_SCOPES,
  parseCron,
  requireOneOf,
  requireRecord,
  requireString,
  toError,
  validateSecretName,
  validateSlug,
} from "../../core/index.js";

import { refuse } from "./validate.js";

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

  for (const key of Object.keys(definition)) {
    if (!["description", "schedule", "secrets", "mode", "scope", "input", "run"].includes(key)) {
      refuse(
        "unknown_property",
        `Unknown definition property '${key}'. Remove it from the definition.`,
      );
    }
  }

  const schedule =
    definition.schedule === undefined ? null : requireRecord(definition.schedule, "Schedule");

  const secrets = definition.secrets ?? [];

  if (
    !Array.isArray(secrets) ||
    !secrets.every((secret: unknown): secret is string => typeof secret === "string")
  ) {
    refuse(
      "invalid_secret",
      "Secrets must be a list of strings. Supply the secret names to expose.",
    );
  }

  try {
    secrets.forEach(validateSecretName);
  } catch (error) {
    refuse("invalid_secret", toError(error).message);
  }

  return {
    description:
      definition.description === undefined
        ? null
        : requireString(definition.description, "Description"),
    schedule: schedule === null ? null : parseSchedule(schedule),
    secrets: [...secrets],
    mode: requireOneOf(definition.mode ?? "sandbox", EXECUTION_MODES, "Loopy mode"),
    scope: requireOneOf(definition.scope ?? "project", LOOPY_SCOPES, "Loopy scope"),
  };
}

// BOUNDARY: A validated object still contains untyped schedule fields from the author module.
function parseSchedule(schedule: Record<string, unknown>): NonNullable<GraphMeta["schedule"]> {
  for (const key of Object.keys(schedule)) {
    if (key !== "cron" && key !== "tz") {
      refuse("unknown_property", `Unknown schedule property '${key}'. Use only 'cron' and 'tz'.`);
    }
  }

  try {
    const parsed: NonNullable<GraphMeta["schedule"]> = {
      cron: requireString(schedule.cron, "Schedule cron"),
      tz: requireString(schedule.tz ?? "UTC", "Schedule timezone"),
    };

    parseCron(parsed.cron);
    assertTimeZone(parsed.tz);

    return parsed;
  } catch (error) {
    refuse("invalid_schedule", toError(error).message);
  }
}
