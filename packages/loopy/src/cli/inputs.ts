import { createInterface } from "node:readline";
import type { Json, Reference, Workflow, WorkflowNode } from "../core/model.js";

type InputKind = "string" | "number" | "boolean";
type InputField = { path: readonly string[]; kind?: InputKind; choices?: string[] };

/** Saved graphs retain input references even though TypeScript input types are erased. */
export function workflowInputs(workflow: Workflow): InputField[] {
  const fields = new Map<string, InputField>();
  function visit(value: unknown, kind?: InputKind, choices?: string[]) {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value) {
      const ref = (value as Reference).$ref;
      if (ref.source !== "input") return;
      const key = JSON.stringify(ref.path);
      const previous = fields.get(key);
      if (previous?.kind && kind && previous.kind !== kind)
        throw new Error(
          `Input ${ref.path.join(".")} requires conflicting types. Use --input JSON.`,
        );
      const allowed =
        previous?.choices && choices
          ? previous.choices.filter((choice) => choices.includes(choice))
          : (previous?.choices ?? choices);
      if (allowed?.length === 0)
        throw new Error(`Input ${ref.path.join(".")} has no shared choices. Use --input JSON.`);
      fields.set(key, { path: ref.path, kind: previous?.kind ?? kind, choices: allowed });
    } else if ("$op" in value) {
      const expression = value as { $op: string; args: unknown[] };
      let operandKind: InputKind | undefined;
      switch (expression.$op) {
        case "gt":
        case "gte":
        case "lt":
        case "lte":
          operandKind = "number";
          break;
        case "and":
        case "or":
        case "not":
          operandKind = "boolean";
          break;
        case "contains":
          operandKind = "string";
          break;
        case "eq":
        case "ne": {
          const literal = expression.args.find(
            (arg) => typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean",
          );
          if (literal !== undefined) operandKind = typeof literal as InputKind;
          break;
        }
      }
      for (const arg of expression.args) visit(arg, operandKind);
    }
  }
  function walk(nodes: WorkflowNode[]) {
    for (const node of nodes) {
      if (node.kind === "condition") {
        visit(node.test, "boolean");
        walk(node.then);
        walk(node.else);
      } else {
        for (const [index, arg] of node.command.args.entries()) {
          const constraint = node.command.argConstraints?.[index];
          if (constraint?.prefix !== undefined) {
            const attached = arg as { args: readonly unknown[] };
            visit(attached.args[1], constraint.kind, constraint.choices);
          } else visit(arg, constraint?.kind, constraint?.choices);
        }
        visit(node.command.stdin);
        for (const value of Object.values(node.command.env ?? {})) visit(value);
      }
    }
  }
  walk(workflow.nodes);
  return [...fields.values()];
}

function hasPath(input: Json, path: readonly string[]): boolean {
  let current = input;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
    current = (current as Record<string, Json>)[key] as Json;
  }
  return true;
}

function setPath(input: Record<string, Json>, path: readonly string[], value: Json) {
  let current = input;
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      Object.defineProperty(current, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return;
    }
    if (!Object.hasOwn(current, key))
      Object.defineProperty(current, key, {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
    const child = current[key];
    if (!child || typeof child !== "object")
      throw new Error(
        `Input ${path.slice(0, index + 1).join(".")} must be an object. Use --input JSON.`,
      );
    current = child as Record<string, Json>;
  }
}

function parseAnswer(answer: string, field: InputField): Json {
  let value: Json = answer;
  if (field.kind === "number") {
    if (!answer.trim() || !Number.isFinite(Number(answer)))
      throw new Error("Enter a finite number.");
    value = Number(answer);
  } else if (field.kind === "boolean") {
    if (!["true", "false"].includes(answer.trim())) throw new Error("Enter true or false.");
    value = answer.trim() === "true";
  } else if (answer.startsWith("json:")) {
    try {
      value = JSON.parse(answer.slice(5)) as Json;
    } catch {
      throw new Error("Enter valid JSON after json:.");
    }
    if (field.kind && typeof value !== field.kind) throw new Error(`Enter a ${field.kind}.`);
  } else if (answer.startsWith("text:")) value = answer.slice(5);
  if (field.choices && !field.choices.includes(String(value)))
    throw new Error(`Choose one of: ${field.choices.join(", ")}.`);
  return value;
}

export async function collectInputs(
  workflow: Workflow,
  supplied: Record<string, Json>,
  ask: (label: string) => Promise<string>,
  report: (message: string) => void,
): Promise<Record<string, Json>> {
  const input = structuredClone(supplied);
  const fields = workflowInputs(workflow).filter((field) => !hasPath(input, field.path));
  for (const [index, field] of fields.entries()) {
    const hint = field.choices?.join(" | ") ?? field.kind ?? "text or json:value";
    while (true) {
      const answer = await ask(
        `[${index + 1}/${fields.length}] ${field.path.join(".")} (${hint}): `,
      );
      let value: Json;
      try {
        value = parseAnswer(answer, field);
      } catch (error) {
        report((error as Error).message);
        continue;
      }
      setPath(input, field.path, value);
      break;
    }
  }
  return input;
}

export async function promptInputs(workflow: Workflow, supplied: Record<string, Json>) {
  if (workflowInputs(workflow).every((field) => hasPath(supplied, field.path))) return supplied;
  console.error(`Run ${workflow.slug}. Enter each input. Ctrl+C cancels before running.`);
  console.error("Text stays text. Use json:value for JSON or text:value for literal text.");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  const lines = terminal[Symbol.asyncIterator]();
  const cancel = () => terminal.close();
  terminal.on("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return await collectInputs(
      workflow,
      supplied,
      async (label) => {
        process.stderr.write(label);
        const line = await lines.next();
        if (line.done) throw new Error("Input cancelled. No run was started.");
        return line.value;
      },
      (message) => console.error(message),
    );
  } finally {
    terminal.close();
    process.removeListener("SIGTERM", cancel);
  }
}
