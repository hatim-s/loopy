import type { SourceArtifact } from "@loopy/contract";
import type { CompilerDiagnosticCode, Diagnostic, Graph, NodeId } from "@loopy/core";
import type { CallSyntax } from "@loopy/sdk/graph-host";

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

export type ParserSource = { file: string; exportName: string };

export type SourceCall = {
  kind: NonNullable<CallSyntax["source"]>;
  label: string;
  start: number;
  end: number;
};

export type AuthorModule = {
  file: string;
  source: string;
  evaluated: string;
  sourceCalls?: SourceCall[];
};
