import type {
  CapabilityRequirement,
  JoinNode,
  JsonObject,
  Predicate,
  ProviderId,
  ReasoningLevel,
  ValueReference,
  VerifyCommandV1,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "@loopy/contracts";

export type EditorPosition = { x: number; y: number };

export type EditorSelection = {
  nodeIds: string[];
  edgeIds: string[];
};

export type EditorValidationStatus = "idle" | "pending" | "valid" | "invalid";

export type EditorValidationDiagnostic = {
  code?: string;
  message: string;
  path?: string;
  severity?: "error" | "warning";
  nodeId?: string;
  edgeId?: string;
};

export type EditorValidation = {
  status: EditorValidationStatus;
  diagnostics: EditorValidationDiagnostic[];
  checkedRevision?: number;
  source?: "local" | "server";
};

export type EditorNodePatch = {
  name?: string;
  description?: string;
  tags?: string[];
  prompt?: string;
  provider?: ProviderId;
  model?: string;
  reasoning?: ReasoningLevel;
  skills?: string[];
  inputBindings?: Record<string, ValueReference>;
  requiredCapabilities?: CapabilityRequirement[];
  completionContract?: "node_completion" | "json";
  commands?: VerifyCommandV1[];
  success?: "all" | "any";
  expectedExitCode?: number;
  message?: string;
  approvalKey?: string;
  expiresAfterMs?: number;
  predicate?: Predicate;
  defaultRoute?: string;
  policy?: JoinNode["policy"];
  quorum?: number;
  outputMode?: JoinNode["outputMode"];
  operation?: "pick" | "merge" | "template";
  mapping?: Record<string, ValueReference>;
};

export type EditorEdgePatch = {
  label?: string;
  condition?: Predicate;
  metadata?: JsonObject;
};

export type EditorCommand =
  | { type: "add_node"; node: WorkflowNode; position?: EditorPosition }
  | { type: "remove_node"; nodeId: string }
  | { type: "update_node"; nodeId: string; patch: EditorNodePatch }
  | { type: "add_edge"; edge: WorkflowEdge }
  | { type: "remove_edge"; edgeId: string }
  | { type: "update_edge"; edgeId: string; patch: EditorEdgePatch }
  | { type: "set_branch_label"; edgeId: string; label: string }
  | {
      type: "set_join_policy";
      nodeId: string;
      policy: JoinNode["policy"];
      quorum?: number;
      outputMode?: JoinNode["outputMode"];
    }
  | { type: "add_verify_command"; nodeId: string; command: VerifyCommandV1 }
  | {
      type: "update_verify_command";
      nodeId: string;
      index: number;
      command: Partial<VerifyCommandV1>;
    }
  | { type: "remove_verify_command"; nodeId: string; index: number }
  | { type: "set_input"; index: number; input: WorkflowDefinition["inputs"][number] }
  | { type: "add_input"; input: WorkflowDefinition["inputs"][number] }
  | { type: "remove_input"; name: string }
  | { type: "set_defaults"; defaults: WorkflowDefinition["defaults"] }
  | { type: "set_policies"; policies: WorkflowDefinition["policies"] }
  | {
      type: "set_workflow_metadata";
      patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "metadata">>;
    };

export type CommandFailure = {
  ok: false;
  reason:
    | "duplicate_id"
    | "missing_node"
    | "missing_edge"
    | "invalid_node"
    | "invalid_edge"
    | "invalid_input"
    | "invalid_command"
    | "duplicate_input"
    | "missing_command";
  message: string;
};

export type CommandSuccess = {
  ok: true;
  changed: boolean;
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
};

export type CommandResult = CommandSuccess | CommandFailure;

export type EditorHistoryEntry = {
  document: WorkflowDefinition;
  positions: Record<string, EditorPosition>;
};

export type ServerValidationResult = {
  valid: boolean;
  diagnostics?: readonly EditorValidationDiagnostic[];
};

export type EditorStateSnapshot = {
  document: WorkflowDefinition;
  positions: Record<string, EditorPosition>;
  selection: EditorSelection;
  dirty: boolean;
  revision: number;
  validation: EditorValidation;
};

export type EditorIdFactory = (kind: "node" | "edge" | "workflow") => string;

export type NewEditorNode = Omit<WorkflowNode, "id">;
export type NewEditorEdge = Omit<WorkflowEdge, "id">;
