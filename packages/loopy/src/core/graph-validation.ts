import type { Diagnostic, DiagnosticCode, Graph, NodeId } from "./graph.js";
import type { Context } from "./graph-context.js";
import type { ResolveType } from "./graph-predicate.js";

export type ValidationContext = Context & { graph: Graph; resolveType: ResolveType };

export function diagnostic(code: DiagnosticCode, node: NodeId | null, message: string): Diagnostic {
  return { code, node, message, source: null };
}
