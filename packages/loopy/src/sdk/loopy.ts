import {
  allowKeys,
  EXECUTION_MODES,
  type ExecutionMode,
  isRecord,
  isStringArray,
  type Json,
  LOOPY_SCOPES,
  requireOneOf,
  requireRecord,
  requireString,
  validateSlug,
} from "../core/index.js";
import { parseCron } from "../runtime/index.js";
import type { log, now, random, uuid } from "./ambient.js";
import { type InferInput, type InputSchema, inputValidator } from "./schema.js";

const LOOPY = Symbol.for("loopy");

export type LoopyContext<Input = unknown> = {
  input: Input;
  log: typeof log;
  now: typeof now;
  random: typeof random;
  uuid: typeof uuid;
};

export type LoopyDefinition<
  Schema extends InputSchema | undefined = undefined,
  Output extends Json = Json,
> = {
  name: string;
  description?: string;
  input?: Schema;
  schedule?: { cron: string; tz?: string };
  scope?: "project" | "global";
  mode?: ExecutionMode;
  secrets?: string[];
  run(context: LoopyContext<InferInput<Schema>>): Output | Promise<Output>;
};

export type Loopy<Input = unknown, Output extends Json = Json> = Readonly<{
  [LOOPY]: true;
  name: string;
  description?: string;
  input?: InputSchema;
  schedule?: Readonly<{ cron: string; tz?: string }>;
  scope: "project" | "global";
  mode: ExecutionMode;
  secrets: readonly string[];
  run(context: LoopyContext<Input>): Promise<Output>;
  // BOUNDARY: Public callers supply external data to the definition's schema.
  validateInput(value: unknown): Promise<Input>;
}>;

// BOUNDARY: Saved modules are unknown until their process-wide SDK brand is checked.
export function isLoopy(value: unknown): value is Loopy {
  return isRecord(value) && LOOPY in value && value[LOOPY] === true;
}

// BOUNDARY: Both definitions and saved JSON must validate their cron and timezone.
export function parseSchedule(schedule: unknown) {
  if (schedule === undefined) {
    return undefined;
  }

  const value = requireRecord(schedule, "Schedule");
  allowKeys(value, "Schedule", ["cron", "tz"]);
  const cron = requireString(value.cron, "Schedule cron");
  parseCron(cron);
  const tz = value.tz === undefined ? undefined : requireString(value.tz, "Schedule timezone");

  if (tz !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch {
      throw new Error(
        `Invalid schedule timezone '${tz}'. Provide an IANA time zone such as 'Asia/Kolkata'.`,
      );
    }
  }

  return Object.freeze({ cron, tz });
}

function validateSecrets(secrets: string[] = []) {
  if (!isStringArray(secrets)) {
    throw new Error("Secrets must be a list of strings. Supply the secret names to expose.");
  }

  return Object.freeze([...secrets]);
}

// BOUNDARY: JavaScript authors can supply malformed definitions despite the TypeScript contract.
function validateDefinition(definition: LoopyDefinition<InputSchema | undefined>) {
  const value = requireRecord(definition, "Loopy definition");
  allowKeys(value, "Loopy definition", [
    "name",
    "description",
    "input",
    "schedule",
    "scope",
    "mode",
    "secrets",
    "run",
  ]);
  validateSlug(requireString(value.name, "Loopy name"));

  if (value.description !== undefined) {
    requireString(value.description, "Loopy description");
  }

  if (typeof value.run !== "function") {
    throw new Error("Loopy run must be a function. Supply a run(context) function.");
  }
}

export function loopy<
  const Schema extends InputSchema | undefined = undefined,
  Output extends Json = Json,
>(definition: LoopyDefinition<Schema, Output>): Loopy<InferInput<Schema>, Output> {
  validateDefinition(definition);
  const { name, description, input, scope = "project", mode = "sandbox", run } = definition;

  return Object.freeze({
    [LOOPY]: true as const,
    name,
    description,
    input,
    scope: requireOneOf(scope, LOOPY_SCOPES, "Loopy scope"),
    mode: requireOneOf(mode, EXECUTION_MODES, "Loopy mode"),
    schedule: parseSchedule(definition.schedule),
    secrets: validateSecrets(definition.secrets),
    validateInput: inputValidator<Schema>(definition.input),
    async run(context: LoopyContext<InferInput<Schema>>) {
      return run(context);
    },
  });
}
