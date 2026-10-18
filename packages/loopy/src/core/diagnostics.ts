import type { NodeId } from "./graph.js";

export const DIAGNOSTIC_CODES = [
  "duplicate_label",
  "reserved_name",
  "inactive_builder",
  "duplicate_node",
  "duplicate_ref",
  "missing_endpoint",
  "missing_entry",
  "unresolved_ref",
  "out_of_scope_ref",
  "operand_type",
  "invalid_size",
  "missing_arm",
  "invalid_scope",
  "scope_escape",
  "unreachable",
  "unknown_flag",
  "flag_type",
  "flag_choice",
  "arity",
  "protected_flag",
  "duplicate_flag",
  "unknown_property",
  "invalid_schedule",
  "invalid_secret",
  "cycle",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type Diagnostic = {
  code: DiagnosticCode;
  message: string;
  node: NodeId | null;
  source: { module: string; line: number; column: number } | null;
};

export const COMPILER_DIAGNOSTIC_CODES = [
  "dynamic_code",
  "options_not_literal",
  "unknown_sdk_call",
  "default_loopy",
  "source_error",
  "evaluation_failed",
  "bundle_failed",
  "syntax_error",
  "literal_required",
  "synchronous_run",
  "invalid_binding",
  "literal_key",
  "module_path",
  "module_default",
  "invalid_callback",
  "forbidden_call",
  "forbidden_expression",
  "invalid_reference",
  "await_forbidden",
  "template_reference",
  "forbidden_statement",
  "descriptor_not_literal",
  "command_key",
  "module_import",
  "cyclic_import",
  "sdk_alias",
  "module_effect",
] as const;

export type CompilerDiagnosticCode = (typeof COMPILER_DIAGNOSTIC_CODES)[number] | DiagnosticCode;

export const DIAGNOSTIC_MESSAGES = {
  duplicate_label: "Labels must be unique inside one scope.",
  reserved_name: "Graph names cannot use reserved object properties.",
  inactive_builder: "Create nodes inside a synchronous loopy run.",
  duplicate_node: "Node ids must be unique.",
  duplicate_ref: "Scope bindings must have unique reference ids.",
  missing_endpoint: "Edge endpoints and control targets must name nodes.",
  missing_entry: "Entry must name a node.",
  unresolved_ref:
    "References must name an available output or binding and match its declared schema.",
  out_of_scope_ref: "Reference is unavailable in this scope.",
  operand_type: "Operands must have the declared types required by their operation.",
  invalid_size: "Size requires a string or array reference in a comparison.",
  missing_arm: "Branch arms must name nodes.",
  invalid_scope: "Control bodies must belong to their enclosing scope.",
  scope_escape: "Edges must stay within a body or use its entry or join.",
  unreachable: "Every node must be reachable from the graph entry.",
  cycle: "Graphs must be acyclic except for scope joins.",
  unknown_flag: "The command flag is unknown.",
  flag_type: "The flag value must match its declared type.",
  flag_choice: "The flag value must be one of its declared choices.",
  arity: "The command has the wrong number of arguments.",
  protected_flag: "This flag is controlled by the command descriptor.",
  duplicate_flag: "Supply each non-repeatable flag only once.",
  unknown_property: "The definition contains an unknown property.",
  invalid_schedule: "Supply a valid cron expression and time zone.",
  invalid_secret: "Supply valid secret names.",
} as const satisfies Record<DiagnosticCode, string>;

export const COMPILER_MESSAGES = {
  ...DIAGNOSTIC_MESSAGES,
  emitted_dynamic_code: "A bundled dependency loads code at run time.",
  dynamic_code: "Use bundled modules instead of runtime loading or code generation.",
  options_not_literal: "Use an inline object literal for SDK options.",
  unknown_sdk_call: "Call an exported SDK function or namespace member.",
  default_loopy: "Default-export a loopy() builder result.",
  source_error: "The source could not be read.",
  evaluation_failed: "The author module could not be evaluated.",
  bundle_failed: "The executable bundle could not be built.",
  syntax_error: "The module has invalid syntax.",
  literal_required: "Use a literal value in graph construction.",
  synchronous_run: "Use a synchronous arrow function for graph construction.",
  invalid_binding: "Use unique immutable bindings and simple callback parameters.",
  literal_key: "Object keys must be strings.",
  module_path: "Executable modules must use a relative file path.",
  module_default: "Executable modules must default-export one function.",
  invalid_callback: "Callbacks belong to control nodes or command parsers.",
  forbidden_call: "Call an SDK export or a declared subgraph only.",
  forbidden_expression: "Use immutable JSON values and graph references in graph construction.",
  invalid_reference: "Use a literal or an immutable graph reference.",
  await_forbidden: "Graph construction cannot await.",
  template_reference: "Use format() to interpolate graph references.",
  forbidden_statement: "Graph construction allows const declarations, SDK calls and return only.",
  descriptor_not_literal: "defineCommand requires a literal descriptor.",
  command_key: "Custom parser keys must be literal, unique and cannot replace built-in commands.",
  module_import: "Use named SDK and author imports.",
  cyclic_import: "Builder imports cannot be cyclic.",
  sdk_alias: "Import SDK exports under their original names.",
  module_effect: "Builder modules allow imports, immutable data, descriptors and subgraphs only.",
} as const satisfies Record<CompilerDiagnosticCode | "emitted_dynamic_code", string>;

export function diagnostic(code: DiagnosticCode, node: NodeId | null, detail?: string): Diagnostic {
  const message = detail ? `${DIAGNOSTIC_MESSAGES[code]} ${detail}` : DIAGNOSTIC_MESSAGES[code];

  return { code, node, message, source: null };
}
