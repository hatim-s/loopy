import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Json, setOwnProperty } from "../core/index.js";
import { assertJson } from "../runtime/index.js";
import { isStandardSchema, type Loopy, type RecordSpec } from "../sdk/host.js";
import type { CliContext } from "./context.js";

// BOUNDARY: JSON input must be validated by the loopy schema before creating a run.
export async function jsonInput(context: CliContext): Promise<Json> {
  const text = context.values["input-json"];
  const file = context.values["input-file"];

  if (file !== undefined) {
    const value: unknown = JSON.parse(await Bun.file(resolve(context.cwd, file)).text());
    assertJson(value, "Input file");

    return value;
  }

  const value: unknown = text === undefined ? {} : JSON.parse(text);
  assertJson(value, "JSON input");

  return value;
}

function coerce(value: string, kind: RecordSpec[string], key: string) {
  if (kind === "string") {
    return value;
  }

  if (kind === "number" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }

  if (kind === "boolean" && (value === "true" || value === "false")) {
    return value === "true";
  }

  throw new Error(`Input --${key} must be a ${kind}. Provide a valid value.`);
}

type NamedInput = Record<string, string | number | boolean>;

async function recordInput(spec: RecordSpec, context: CliContext) {
  const input: NamedInput = {};
  Object.assign(input, context.triggerInput);

  const prompt =
    process.stdin.isTTY && process.stderr.isTTY
      ? createInterface({ input: process.stdin, output: process.stderr })
      : undefined;

  try {
    for (const [field, kind] of Object.entries(spec)) {
      const key = field.replace(/\?$/, "");
      const supplied = context.triggerInput?.[key];

      const value =
        supplied ??
        (!field.endsWith("?") && prompt ? await prompt.question(`${key}: `) : undefined);

      if (value !== undefined) {
        setOwnProperty(input, key, coerce(value, kind, key));
      }
    }

    return input;
  } finally {
    prompt?.close();
  }
}

// BOUNDARY: The SDK validates CLI input against the author's schema.
export async function sdkInput(loopy: Loopy, context: CliContext): Promise<Json> {
  if (context.values["input-json"] !== undefined || context.values["input-file"] !== undefined) {
    return jsonInput(context);
  }

  if (isStandardSchema(loopy.input)) {
    throw new Error(
      "This loopy uses a Standard Schema. Supply --input-json '<json>' or --input-file <path>.",
    );
  }

  return recordInput(loopy.input ?? {}, context);
}
