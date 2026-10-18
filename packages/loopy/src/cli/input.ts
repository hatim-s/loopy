import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  assertJson,
  errorMessage,
  isFieldValue,
  type Json,
  type RecordSpec,
  recordFields,
  setOwnProperty,
} from "../core/index.js";
import type { CliContext } from "./context.js";
import { DaemonError } from "./errors.js";

export async function jsonInput(context: CliContext): Promise<Json> {
  const file = context.values["input-file"];

  const text =
    file === undefined
      ? (context.values["input-json"] ?? "{}")
      : await Bun.file(resolve(context.cwd, file)).text();

  try {
    const value: unknown = JSON.parse(text);
    assertJson(value, "JSON input");

    return value;
  } catch (error) {
    throw new DaemonError("bad_request", errorMessage(error));
  }
}

function coerce(value: string, kind: RecordSpec[string], key: string) {
  if (kind === "json" || kind.endsWith("[]")) {
    try {
      const parsed: unknown = JSON.parse(value);

      if (isFieldValue(kind, parsed)) {
        return parsed;
      }
    } catch {
      throw new DaemonError("bad_request", `Input --${key} must be valid JSON.`);
    }

    throw new DaemonError(
      "bad_request",
      `Input --${key} must be a ${kind}. Provide a valid value.`,
    );
  }

  if (kind === "string") {
    return value;
  }

  if (kind === "number" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }

  if (kind === "boolean" && (value === "true" || value === "false")) {
    return value === "true";
  }

  throw new DaemonError("bad_request", `Input --${key} must be a ${kind}. Provide a valid value.`);
}

type NamedInput = Record<string, Json>;

async function recordInput(spec: RecordSpec, context: CliContext) {
  const input: NamedInput = {};
  Object.assign(input, context.namedInput);

  const prompt =
    process.stdin.isTTY && process.stderr.isTTY
      ? createInterface({ input: process.stdin, output: process.stderr })
      : undefined;

  try {
    for (const { key, type: kind, optional } of recordFields(spec)) {
      const supplied = context.namedInput?.[key];

      const value =
        supplied ?? (!optional && prompt ? await prompt.question(`${key}: `) : undefined);

      if (value !== undefined) {
        setOwnProperty(input, key, coerce(value, kind, key));
      }
    }

    return input;
  } finally {
    prompt?.close();
  }
}

export async function graphInput(spec: RecordSpec, context: CliContext): Promise<Json> {
  if (context.values["input-json"] !== undefined || context.values["input-file"] !== undefined) {
    return jsonInput(context);
  }

  return recordInput(spec, context);
}
