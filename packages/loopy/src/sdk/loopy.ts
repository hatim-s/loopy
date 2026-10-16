import {
  type ExecutionMode,
  isStringArray,
  type Json,
  requireOneOf,
  requireRecord,
  requireString,
  validateSlug,
} from "../core/index.js";
import type { LoopyContext } from "../runtime/index.js";
import { type InputSchema, type inferInput, inputValidator } from "./schema.js";

const LOOPY = Symbol("loopy");

type RunContext<Input> = Pick<LoopyContext, "log" | "now" | "random" | "uuid"> & { input: Input };

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
  run: (context: RunContext<inferInput<Schema>>) => Promise<Output>;
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
  run: (context: RunContext<Input>) => Promise<Output>;
  // BOUNDARY: Public callers supply external data to the definition's schema.
  validateInput(value: unknown): Promise<Input>;
}>;

function validateSchedule(schedule: LoopyDefinition["schedule"]) {
  if (schedule === undefined) {
    return undefined;
  }

  const value = requireRecord(schedule, "Schedule");
  const cron = requireString(value.cron, "Schedule cron");

  const tz = value.tz === undefined ? undefined : requireString(value.tz, "Schedule timezone");

  return Object.freeze({ cron, tz });
}

function validateSecrets(secrets: string[] = []) {
  if (!isStringArray(secrets)) {
    throw new Error("Secrets must be a list of strings. Supply the secret names to expose.");
  }

  return Object.freeze([...secrets]);
}

export function loopy<
  const Schema extends InputSchema | undefined = undefined,
  Output extends Json = Json,
>(definition: LoopyDefinition<Schema, Output>): Loopy<inferInput<Schema>, Output> {
  validateSlug(requireString(definition.name, "Loopy name"));

  if (definition.description !== undefined) {
    requireString(definition.description, "Loopy description");
  }

  const { scope = "project", mode = "sandbox" } = definition;
  requireOneOf(scope, ["project", "global"], "Loopy scope");
  requireOneOf(mode, ["sandbox", "full"], "Loopy mode");
  const schedule = validateSchedule(definition.schedule);
  const secrets = validateSecrets(definition.secrets);
  const validateInput = inputValidator<Schema>(definition.input);

  return Object.freeze({
    ...definition,
    [LOOPY]: true,
    scope,
    mode,
    schedule,
    secrets,
    validateInput,
  } satisfies Loopy<inferInput<Schema>, Output>);
}
