import type { Json, WorkflowNode } from "../core/model.js";
import { errorMessage } from "./errors.js";
import { type Outputs, resolveAvailableValue, validateCommandInput } from "./values.js";

export class InputValidationError extends Error {
  constructor(
    readonly nodeId: string,
    message: string,
  ) {
    super(`Node ${nodeId}: ${message}`);
    this.name = "InputValidationError";
  }
}

/** Checks reachable inputs without executing commands or guessing future outputs. */
export function validateRunInput(
  nodes: readonly WorkflowNode[],
  input: Json,
  outputs: Outputs = new Map(),
): void {
  for (const node of nodes) {
    if (outputs.has(node.id)) {
      if (node.kind === "command") continue;
      const recorded = outputs.get(node.id) as { branch?: string };
      if (recorded.branch === "then" || recorded.branch === "else") {
        validateRunInput(node[recorded.branch], input, outputs);
        continue;
      }
    }
    try {
      if (node.kind === "command") {
        validateCommandInput(node, input, outputs);
        continue;
      }
      const test = resolveAvailableValue(node.test, input, outputs);
      if (!test) continue;
      if (typeof test.value !== "boolean") throw new Error("Condition must resolve to boolean");
      validateRunInput(test.value ? node.then : node.else, input, outputs);
    } catch (error) {
      if (error instanceof InputValidationError) throw error;
      throw new InputValidationError(node.id, errorMessage(error));
    }
  }
}
