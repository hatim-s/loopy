import {
  type Diagnostic,
  type DiagnosticCode,
  type Graph,
  type NodeId,
  validateGraph,
} from "../../core/index.js";

export class GraphBuildError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "GraphBuildError";
  }
}

export function refuse(code: DiagnosticCode, message: string, node: NodeId | null = null): never {
  throw new GraphBuildError({ code, message, node, source: null });
}

export function validate(graph: Graph): Diagnostic[] {
  return validateGraph(graph);
}

export function validateArguments(graph: Graph): void {
  const error = validateGraph(graph).find((error) =>
    ["predicate_type", "invalid_size", "unresolved_ref"].includes(error.code),
  );

  if (error) {
    throw new GraphBuildError({ ...error, node: null });
  }
}
