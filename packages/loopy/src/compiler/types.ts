import type { CompilerDiagnosticCode, Diagnostic, Graph, NodeId } from "../core/index.js";

export type CompilerDiagnostic = {
  code: CompilerDiagnosticCode;
  message: string;
  source: NonNullable<Diagnostic["source"]>;
};

export type Bundle = { nodeId: NodeId; bundleHash: string; bytes: Uint8Array };

export type CompileResult =
  | { ok: true; graph: Graph; bundles: Bundle[]; revision: string }
  | { ok: false; diagnostics: CompilerDiagnostic[] };

export type AuthorModule = { file: string; evaluated: string };

export type Restricted = {
  ok: true;
  modules: AuthorModule[];
  parsers: Map<string, string>;
};
