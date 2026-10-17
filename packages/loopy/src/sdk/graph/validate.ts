import {
  checkPredicate,
  type Diagnostic,
  type DiagnosticCode,
  type Graph,
  graphTypeResolver,
  type NodeId,
  type Predicate,
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

export function validatePredicate(
  predicate: Predicate,
  graph: Pick<Graph, "input" | "nodes" | "edges">,
): void {
  const error = checkPredicate(predicate, graphTypeResolver(graph))[0];

  if (error) {
    throw new GraphBuildError({ ...error, node: null, source: null });
  }
}
