import { createInterface } from "node:readline";
import type { Json, Workflow } from "../core/index.js";
import { errorMessage, isRecord, setOwnProperty } from "../core/index.js";
import { type InputField, workflowInputs } from "./input-fields.js";
import { report } from "./output.js";

type JsonRecord = Record<string, Json>;

function isJsonRecord(value: Json): value is JsonRecord {
  return isRecord(value);
}

function hasPath(input: Json, path: readonly string[]): boolean {
  let current: unknown = input;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      return false;
    }
    current = current[key];
  }
  return true;
}

function setPath(input: JsonRecord, path: readonly string[], value: Json): void {
  let current = input;
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      setOwnProperty(current, key, value);
      return;
    }
    if (!Object.hasOwn(current, key)) {
      setOwnProperty<Json>(current, key, {});
    }
    const child = current[key];
    if (child === undefined || !isJsonRecord(child)) {
      throw new Error(
        `Input ${path.slice(0, index + 1).join(".")} must be an object. Use --input JSON.`,
      );
    }
    current = child;
  }
}

function parseJsonAnswer(text: string, field: InputField): Json {
  let value: Json;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Enter valid JSON after json:.");
  }
  if (field.kind && typeof value !== field.kind) {
    throw new Error(`Enter a ${field.kind}.`);
  }
  return value;
}

function parseTypedAnswer(answer: string, field: InputField): Json {
  if (field.kind === "number") {
    if (!answer.trim() || !Number.isFinite(Number(answer))) {
      throw new Error("Enter a finite number.");
    }
    return Number(answer);
  }
  if (field.kind === "boolean") {
    if (!["true", "false"].includes(answer.trim())) {
      throw new Error("Enter true or false.");
    }
    return answer.trim() === "true";
  }
  if (answer.startsWith("json:")) {
    return parseJsonAnswer(answer.slice(5), field);
  }
  return answer.startsWith("text:") ? answer.slice(5) : answer;
}

function parseAnswer(answer: string, field: InputField): Json {
  const value = parseTypedAnswer(answer, field);
  if (field.choices && !field.choices.includes(String(value))) {
    throw new Error(`Choose one of: ${field.choices.join(", ")}.`);
  }
  return value;
}

export async function collectInputs(
  workflow: Workflow,
  supplied: JsonRecord,
  ask: (label: string) => Promise<string>,
  warn: (message: string) => void,
): Promise<JsonRecord> {
  const input = structuredClone(supplied);
  const fields = workflowInputs(workflow).filter((field) => !hasPath(input, field.path));
  for (const [index, field] of fields.entries()) {
    // An earlier JSON answer may have filled a nested path already.
    if (hasPath(input, field.path)) {
      continue;
    }
    const hint = field.choices?.join(" | ") ?? field.kind ?? "text or json:value";
    while (true) {
      const answer = await ask(
        `[${index + 1}/${fields.length}] ${field.path.join(".")} (${hint}): `,
      );
      try {
        setPath(input, field.path, parseAnswer(answer, field));
        break;
      } catch (error) {
        warn(errorMessage(error));
      }
    }
  }
  return input;
}

export async function promptInputs(workflow: Workflow, supplied: JsonRecord): Promise<JsonRecord> {
  if (workflowInputs(workflow).every((field) => hasPath(supplied, field.path))) {
    return supplied;
  }
  report(`Run ${workflow.slug}. Enter each input. Ctrl+C cancels before running.`);
  report("Text stays text. Use json:value for JSON or text:value for literal text.");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  const lines = terminal[Symbol.asyncIterator]();
  const cancel = () => terminal.close();
  terminal.on("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const ask = async (label: string) => {
    process.stderr.write(label);
    const line = await lines.next();
    if (line.done) {
      throw new Error("Input cancelled. No run was started.");
    }
    return line.value;
  };
  try {
    return await collectInputs(workflow, supplied, ask, report);
  } finally {
    terminal.close();
    process.removeListener("SIGTERM", cancel);
  }
}
