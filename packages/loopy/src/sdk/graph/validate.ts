import {
  checkPredicate,
  type Diagnostic,
  type DiagnosticCode,
  diagnostic,
  type Graph,
  graphTypeResolver,
  isReservedGraphName,
  type Predicate,
} from "../../core/index.js";

export class GraphBuildError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "GraphBuildError";
  }
}

export function refuse(code: DiagnosticCode, detail?: string): never {
  throw new GraphBuildError(diagnostic(code, null, detail));
}

export function validatePredicate(
  predicate: Predicate,
  graph: Pick<Graph, "input" | "nodes" | "edges">,
): void {
  const error = checkPredicate(predicate, graphTypeResolver(graph))[0];

  if (error) {
    throw new GraphBuildError({ ...error, node: null, source: null });
  }
}

export function validateLabel(label: string): void {
  if (isReservedGraphName(label)) {
    refuse("reserved_name", `Label "${label}" is reserved. Choose another name.`);
  }
}
