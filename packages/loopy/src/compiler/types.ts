import type { SourceArtifact } from "../contract/index.js";
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
  | {
      ok: true;
      graph: Graph;
      bundles: Bundle[];
      revision: string;
      warnings: Diagnostic[];
      sourceArtifact: SourceArtifact;
    }
  | { ok: false; diagnostics: CompilerDiagnostic[] };

export type ParserSource = { file: string };

export type SourceCall = { kind: "code" | "wait"; label: string; start: number; end: number };

export type AuthorModule = {
  file: string;
  source: string;
  evaluated: string;
  sourceCalls?: SourceCall[];
};

export type Restricted = {
  ok: true;
  modules: AuthorModule[];
  parsers: Map<string, ParserSource>;
};
