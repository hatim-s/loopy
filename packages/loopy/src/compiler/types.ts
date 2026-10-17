import type { CompilerDiagnosticCode, Diagnostic, Graph, NodeId } from "../core/index.js";

export type CompilerDiagnostic = {
  code: CompilerDiagnosticCode;
  message: string;
  file: string;
  line: number;
  column: number;
};

export type Bundle = { nodeId: NodeId; bundleHash: string; bytes: Uint8Array };

export type CompileResult =
  | { ok: true; graph: Graph; bundles: Bundle[]; revision: string; warnings: Diagnostic[] }
  | { ok: false; diagnostics: CompilerDiagnostic[] };

export type ParserSource = { file: string; source: string };

export type AuthorModule = { file: string; source: string; evaluated: string };

export type Restricted = {
  ok: true;
  modules: AuthorModule[];
  parsers: Map<string, ParserSource>;
};
