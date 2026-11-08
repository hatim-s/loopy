import type { Diagnostic, DiagnosticCode, Graph } from ".";
import type { Context } from "./context";
import type { ResolveType } from "./predicate";
import type { NodeId } from "./values";

export type ValidationContext = Context & { graph: Graph; resolveType: ResolveType };

export function diagnostic(code: DiagnosticCode, node: NodeId | null, message: string): Diagnostic {
  return { code, node, message, source: null };
}
