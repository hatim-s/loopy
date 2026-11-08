import type { SourceArtifact } from "@loopy/contract";
import type { Diagnostic, DiagnosticCode, Graph, NodeId } from "@loopy/core";
import type { CallSyntax } from "@loopy/sdk/graph-host";

export type CompilerDiagnosticCode =
  | DiagnosticCode
  | "dynamic_code"
  | "options_not_literal"
  | "unknown_sdk_call"
  | "default_loopy"
  | "source_error"
  | "evaluation_failed"
  | "bundle_failed"
  | "syntax_error"
  | "literal_required"
  | "synchronous_run"
  | "invalid_binding"
  | "literal_key"
  | "module_path"
  | "module_default"
  | "invalid_callback"
  | "forbidden_call"
  | "forbidden_expression"
  | "invalid_reference"
  | "await_forbidden"
  | "template_reference"
  | "forbidden_statement"
  | "command_descriptor"
  | "command_key"
  | "module_import"
  | "cyclic_import"
  | "sdk_alias"
  | "module_effect";

export type CompilerDiagnostic = {
  code: CompilerDiagnosticCode;
  message: string;
  file: string;
  line: number;
  column: number;
};

export type Bundle = { nodeId: NodeId; bundleHash: string; bytes: Uint8Array<ArrayBuffer> };

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
