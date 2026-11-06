import type { Diagnostic, DiagnosticCode, Graph, NodeId } from ".";
import type { Context } from "./context";
import type { ResolveType } from "./predicate";

export type ValidationContext = Context & { graph: Graph; resolveType: ResolveType };

export function diagnostic(code: DiagnosticCode, node: NodeId | null, message: string): Diagnostic {
  return { code, node, message, source: null };
}
