import {
  EXECUTION_MODES,
  FIELD_TYPES,
  type GraphMeta,
  LOOPY_SCOPES,
  parseCron,
  requireOneOf,
  requireRecord,
  requireString,
  validateSecretName,
  validateSlug,
} from "../../core/index.js";

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
      throw new Error(`Unknown definition property '${key}'. Remove it from the definition.`);
    }
  }

  const schedule =
    definition.schedule === undefined ? null : requireRecord(definition.schedule, "Schedule");

  const secrets = definition.secrets ?? [];

  if (
    !Array.isArray(secrets) ||
    !secrets.every((secret: unknown): secret is string => typeof secret === "string")
  ) {
    throw new Error("Secrets must be a list of strings. Supply the secret names to expose.");
  }

  secrets.forEach(validateSecretName);

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
      throw new Error(`Unknown schedule property '${key}'. Use only 'cron' and 'tz'.`);
    }
  }

  const parsed: NonNullable<GraphMeta["schedule"]> = {
    cron: requireString(schedule.cron, "Schedule cron"),
  };

  parseCron(parsed.cron);

  if (schedule.tz !== undefined) {
    parsed.tz = requireString(schedule.tz, "Schedule timezone");

    try {
      new Intl.DateTimeFormat("en", { timeZone: parsed.tz });
    } catch {
      throw new Error(
        `Invalid time zone '${parsed.tz}'. Provide an IANA time zone such as 'Asia/Kolkata'.`,
      );
    }
  }

  return parsed;
}
