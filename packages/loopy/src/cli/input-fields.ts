import type { ArgConstraint, UnknownRecord, Workflow, WorkflowNode } from "../core/index.js";
import { isRecord, requireString } from "../core/index.js";

export type InputKind = "string" | "number" | "boolean";
export type InputField = { path: readonly string[]; kind?: InputKind; choices?: string[] };

type Evidence = {
  path: readonly string[];
  required: Set<InputKind>;
  hints: Set<InputKind>;
  choices: string[] | undefined;
};
type EvidenceMap = Map<string, Evidence>;
type OperandKind = { kind: InputKind | undefined; hint: boolean };

const OPERAND_KINDS = new Map<string, InputKind>([
  ["gt", "number"],
  ["gte", "number"],
  ["lt", "number"],
  ["lte", "number"],
  ["and", "boolean"],
  ["or", "boolean"],
  ["not", "boolean"],
  ["contains", "string"],
]);

function literalKind(args: unknown[]): InputKind | undefined {
  for (const arg of args) {
    if (typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean") {
      return typeof arg === "string" ? "string" : typeof arg === "number" ? "number" : "boolean";
    }
  }
  return undefined;
}

/** Equality against a literal only hints at the kind; comparison operators require it. */
function operandKind(operator: string, args: unknown[]): OperandKind {
  if (operator === "eq" || operator === "ne") {
    return { kind: literalKind(args), hint: true };
  }
  return { kind: OPERAND_KINDS.get(operator), hint: false };
}

function inputReferencePath(value: UnknownRecord): string[] | undefined {
  const ref = value.$ref;
  if (!isRecord(ref) || ref.source !== "input" || !Array.isArray(ref.path)) {
    return undefined;
  }
  return ref.path.map((key, index) => requireString(key, `Input reference path[${index}]`));
}

function recordReference(
  evidence: EvidenceMap,
  path: string[],
  kind: InputKind | undefined,
  choices: string[] | undefined,
  hint: boolean,
): void {
  const key = JSON.stringify(path);
  const existing = evidence.get(key);
  const entry = existing ?? { path, required: new Set(), hints: new Set(), choices };
  if (existing) {
    // Choices survive only when every reference constrains them; otherwise any text is valid.
    entry.choices =
      existing.choices && choices ? [...new Set([...existing.choices, ...choices])] : undefined;
  }
  if (kind) {
    (hint ? entry.hints : entry.required).add(kind);
  }
  evidence.set(key, entry);
}

function visitValue(
  evidence: EvidenceMap,
  value: unknown,
  kind?: InputKind,
  choices?: string[],
  hint = false,
): void {
  if (!isRecord(value)) {
    return;
  }
  const path = inputReferencePath(value);
  if (path) {
    recordReference(evidence, path, kind, choices, hint);
    return;
  }
  if (typeof value.$op !== "string" || !Array.isArray(value.args)) {
    return;
  }
  const operand = operandKind(value.$op, value.args);
  for (const arg of value.args) {
    visitValue(evidence, arg, operand.kind, undefined, operand.hint);
  }
}

function visitArgument(evidence: EvidenceMap, arg: unknown, constraint?: ArgConstraint): void {
  if (constraint?.prefix === undefined) {
    visitValue(evidence, arg, constraint?.kind, constraint?.choices);
    return;
  }
  // A prefixed argument is concat(prefix, value); the constraint describes the value.
  if (isRecord(arg) && Array.isArray(arg.args)) {
    visitValue(evidence, arg.args[1], constraint.kind, constraint.choices);
  }
}

function walkNodes(evidence: EvidenceMap, nodes: WorkflowNode[]): void {
  for (const node of nodes) {
    if (node.kind === "condition") {
      visitValue(evidence, node.test, "boolean");
      walkNodes(evidence, node.then);
      walkNodes(evidence, node.else);
      continue;
    }
    for (const [index, arg] of node.command.args.entries()) {
      visitArgument(evidence, arg, node.command.argConstraints?.[index]);
    }
    visitValue(evidence, node.command.stdin);
    for (const value of Object.values(node.command.env ?? {})) {
      visitValue(evidence, value);
    }
  }
}

function toField(entry: Evidence): InputField {
  const candidates = new Set([...entry.required, ...entry.hints]);
  return {
    path: entry.path,
    kind: candidates.size === 1 ? [...candidates][0] : undefined,
    choices: entry.choices,
  };
}

/** Saved graphs retain input references even though TypeScript input types are erased. */
export function workflowInputs(workflow: Workflow): InputField[] {
  const evidence: EvidenceMap = new Map();
  walkNodes(evidence, workflow.nodes);
  return [...evidence.values()].map(toField);
}
