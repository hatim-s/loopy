import type {
  AgentNode,
  ApprovalNode,
  JoinNode,
  RouteNode,
  ShellNode,
  TransformNode,
  VerifyNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "@loopy/contracts";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  CheckCircle,
  DownloadSimple,
  FloppyDisk,
  GitBranch,
  MagicWand,
  Minus,
  Play,
  Plus,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  applyNodeChanges,
  Background,
  type Connection,
  ConnectionLineType,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../app/api";
import { StepLibrary, steps } from "./builder/palette";
import { RunConsole } from "./builder/run-console";
import { ValueSource } from "./builder/values";
import "./builder/builder.css";
import { ErrorState, LoadingState } from "../components/primitives/states";
import {
  createEditorStore,
  diffWorkflowVersions,
  type EditorNodePatch,
  keyboardIntent,
} from "./editor-core/index.ts";

export type EditorWorkflowRecord = {
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  createdAt?: string;
};

export type EditorDiagnostic = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type WorkflowEditorAdapter = {
  load: (workflowId: string, version?: number) => Promise<EditorWorkflowRecord>;
  save: (input: {
    workflowId: string;
    baseVersion: number;
    definition: WorkflowDefinition;
    summary: string;
  }) => Promise<EditorWorkflowRecord>;
  run: (
    workflowId: string,
    version: number,
    input?: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  validate: (definition: WorkflowDefinition) => Promise<{
    valid: boolean;
    diagnostics?: Array<{
      code?: string;
      message: string;
      path?: string;
      severity?: "error" | "warning";
    }>;
  }>;
};

const asWorkflow = (value: unknown): EditorWorkflowRecord | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const definition = source.definition;
  if (!definition || typeof definition !== "object") return undefined;
  const workflow = definition as WorkflowDefinition;
  if (typeof source.workflowId !== "string" || typeof source.version !== "number") return undefined;
  return {
    workflowId: source.workflowId,
    version: source.version,
    definition: workflow,
    ...(typeof source.createdAt === "string" ? { createdAt: source.createdAt } : {}),
  };
};

export function createWorkflowEditorAdapter(api: ApiClient): WorkflowEditorAdapter {
  return {
    async load(workflowId, version) {
      const path =
        version === undefined
          ? `/workflows/${encodeURIComponent(workflowId)}`
          : `/workflows/${encodeURIComponent(workflowId)}/${version}`;
      const response = await api.request<unknown>(path);
      const record =
        asWorkflow(response) ??
        (response &&
        typeof response === "object" &&
        Array.isArray((response as { versions?: unknown[] }).versions)
          ? asWorkflow((response as { versions: unknown[] }).versions.at(-1))
          : undefined);
      if (!record) throw new Error("The local API returned an invalid workflow version.");
      return record;
    },
    async save({ workflowId, baseVersion, definition, summary }) {
      void summary;
      const previous = await api.request<EditorWorkflowRecord>(
        `/workflows/${encodeURIComponent(workflowId)}/${baseVersion}`,
      );
      const operations = workflowPatchOperations(previous.definition, definition);
      const result = await api.request<unknown>(
        `/workflows/${encodeURIComponent(workflowId)}/patch`,
        {
          method: "POST",
          body: JSON.stringify({ baseVersion, operations }),
        },
      );
      const record = asWorkflow(result);
      if (!record) throw new Error("The local API returned an invalid saved workflow version.");
      return record;
    },
    async run(workflowId, version, input = {}) {
      const run = await api.request<{ id?: string; runId?: string }>("/runs", {
        method: "POST",
        body: JSON.stringify({ workflowId, version, input }),
      });
      const id = run.id ?? run.runId;
      if (!id) throw new Error("The local API did not return a run id.");
      return { id };
    },
    async validate(definition) {
      return api.request(`/workflows/${encodeURIComponent(definition.id)}/validate`, {
        method: "POST",
        body: JSON.stringify({ definition }),
      });
    },
  };
}

function workflowPatchOperations(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): Array<Record<string, unknown>> {
  const operations: Array<Record<string, unknown>> = [];
  if (before.name !== after.name) operations.push({ op: "set_workflow_name", name: after.name });
  if ((before.description ?? null) !== (after.description ?? null))
    operations.push({ op: "set_workflow_description", description: after.description ?? null });
  if (JSON.stringify(before.defaults) !== JSON.stringify(after.defaults))
    operations.push({ op: "set_provider_defaults", defaults: after.defaults });
  if (JSON.stringify(before.policies) !== JSON.stringify(after.policies))
    operations.push({ op: "set_policy", policies: after.policies });
  const beforeInputs = new Map(before.inputs.map((input) => [input.name, input]));
  const afterInputs = new Map(after.inputs.map((input) => [input.name, input]));
  for (const name of beforeInputs.keys())
    if (!afterInputs.has(name)) operations.push({ op: "remove_input", name });
  for (const input of after.inputs) {
    if (JSON.stringify(beforeInputs.get(input.name)) !== JSON.stringify(input))
      operations.push({ op: "set_input", input });
  }
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  for (const node of before.nodes)
    if (!afterNodes.has(node.id)) operations.push({ op: "remove_node", nodeId: node.id });
  for (const node of after.nodes) {
    if (!beforeNodes.has(node.id)) operations.push({ op: "add_node", node });
    else if (JSON.stringify(beforeNodes.get(node.id)) !== JSON.stringify(node))
      operations.push({ op: "replace_node", node });
  }
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const removedNodeIds = new Set(
    before.nodes.filter((node) => !afterNodes.has(node.id)).map((node) => node.id),
  );
  for (const edge of before.edges)
    if (
      !afterEdges.has(edge.id) &&
      !removedNodeIds.has(edge.source) &&
      !removedNodeIds.has(edge.target)
    )
      operations.push({ op: "remove_edge", edgeId: edge.id });
  for (const edge of after.edges) {
    if (!beforeEdges.has(edge.id)) operations.push({ op: "add_edge", edge });
    else if (JSON.stringify(beforeEdges.get(edge.id)) !== JSON.stringify(edge)) {
      const previous = beforeEdges.get(edge.id);
      if (
        previous &&
        (previous.source !== edge.source ||
          previous.target !== edge.target ||
          ((previous.label ?? null) !== (edge.label ?? null) && !edge.label) ||
          JSON.stringify(previous.metadata) !== JSON.stringify(edge.metadata))
      ) {
        operations.push({ op: "remove_edge", edgeId: edge.id });
        operations.push({ op: "add_edge", edge });
        continue;
      }
      if (edge.label && previous?.label !== edge.label)
        operations.push({ op: "set_edge_label", edgeId: edge.id, label: edge.label });
      if (edge.condition && JSON.stringify(previous?.condition) !== JSON.stringify(edge.condition))
        operations.push({ op: "set_edge_condition", edgeId: edge.id, condition: edge.condition });
    }
  }
  if (operations.length === 0) operations.push({ op: "set_workflow_name", name: after.name });
  return operations;
}

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0")}`
  );
}

function now(): string {
  return new Date().toISOString();
}

function fallbackWorkflow(workflowId: string): WorkflowDefinition {
  const agent = uuid();
  const verify = uuid();
  const edge = uuid();
  return {
    schemaVersion: "1",
    workflowVersion: 1,
    id: workflowId,
    name: "Untitled workflow",
    description: "A locally authored Loopy workflow.",
    inputs: [],
    nodes: [
      {
        id: agent,
        kind: "agent",
        name: "Agent step",
        prompt: "Describe the work this agent should complete.",
        provider: "codex",
        skills: [],
        inputBindings: {},
        requiredCapabilities: [],
        completionContract: "node_completion",
        tags: [],
      },
      {
        id: verify,
        kind: "verify",
        name: "Verify",
        commands: [{ command: "bun", args: ["test"], timeoutMs: 120_000 }],
        success: "all",
        expectedExitCode: 0,
        tags: [],
      },
    ],
    edges: [{ id: edge, source: agent, target: verify, metadata: {} }],
    defaults: {
      provider: "codex",
      reasoning: "medium",
      timeoutMs: 3_600_000,
      retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    },
    policies: {
      tools: { allow: [], deny: [], network: "disabled" },
      workspace: { writableRoots: [], useGitWorktree: true, allowDirtyWorkspace: false },
      approval: { requiredBefore: [], sideEffectLabels: [] },
      budget: { timeoutMs: 3_600_000 },
      concurrency: { maxParallel: 1 },
    },
    triggers: { manual: true },
    metadata: { createdAt: now(), updatedAt: now(), createdFrom: "manual", tags: [] },
  };
}

type EditorNodeData = {
  runStatus?: string;
  workflowNode: WorkflowNode;
  position?: { x: number; y: number };
};
type EditorNode = Node<EditorNodeData, "workflow">;

function nodeSubtitle(node: WorkflowNode): string {
  if (node.kind === "agent")
    return `${node.provider ?? "default provider"}${node.model ? ` · ${node.model}` : ""}`;
  if (node.kind === "verify")
    return `${node.commands.length} command${node.commands.length === 1 ? "" : "s"}`;
  if (node.kind === "approval") return "human checkpoint";
  if (node.kind === "route")
    return node.defaultRoute ? `default → ${node.defaultRoute}` : "conditional branch";
  if (node.kind === "join") return `${node.policy} / ${node.outputMode}`;
  if (node.kind === "shell") return `${node.stages.length} Bash stages`;
  return node.operation;
}

function WorkflowNodeCard({ data, selected }: { data: EditorNodeData; selected?: boolean }) {
  const node = data.workflowNode;
  const Icon = steps.find((step) => step.kind === node.kind)?.icon ?? GitBranch;
  return (
    <button
      type="button"
      className={`canvas-node ${selected ? "selected" : ""} node-status-${data.runStatus ?? "idle"}`}
      aria-label={`${node.name} ${node.kind} node`}
    >
      <Handle type="target" position={Position.Left} className="workflow-handle" />
      <div className="canvas-node-head">
        <span className="canvas-node-icon">
          <Icon size={16} />
        </span>
        <span className="canvas-node-title">
          <strong>{node.name}</strong>
          <code>{nodeSubtitle(node)}</code>
        </span>
        {data.runStatus ? (
          <span className="node-status" title={data.runStatus}>
            {data.runStatus === "succeeded" ? "✓" : data.runStatus === "failed" ? "!" : "•"}
          </span>
        ) : null}
      </div>
      <p className="node-prompt">
        {node.kind === "agent"
          ? node.prompt
          : node.kind === "shell"
            ? node.stages.join(" | ")
            : (node.description ?? nodeSubtitle(node))}
      </p>
      {node.kind === "route" ? (
        <>
          <Handle
            id={String(true)}
            type="source"
            position={Position.Right}
            style={{ top: "35%" }}
            className="workflow-handle"
          />
          <Handle
            id={String(false)}
            type="source"
            position={Position.Right}
            style={{ top: "75%" }}
            className="workflow-handle"
          />
          <span className="route-label route-label-true">true</span>
          <span className="route-label route-label-false">false</span>
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="workflow-handle" />
      )}
    </button>
  );
}

const nodeTypes = { workflow: WorkflowNodeCard };

function toFlowNodes(
  workflow: WorkflowDefinition,
  positions?: Record<string, { x: number; y: number }>,
  selectedNodeIds: readonly string[] = [],
): EditorNode[] {
  const selected = new Set(selectedNodeIds);
  return workflow.nodes.map((workflowNode, index) => ({
    id: workflowNode.id,
    type: "workflow",
    position: positions?.[workflowNode.id] ??
      workflowNode.position ?? {
        x: 80 + (index % 3) * 250,
        y: 90 + Math.floor(index / 3) * 150,
      },
    data: { workflowNode },
    selected: selected.has(workflowNode.id),
  }));
}

function toFlowEdges(
  workflow: WorkflowDefinition,
  selectedEdgeIds: readonly string[] = [],
): Edge[] {
  const selected = new Set(selectedEdgeIds);
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    data: { workflowEdge: edge },
    sourceHandle:
      workflow.nodes.find((node) => node.id === edge.source)?.kind === "route"
        ? edge.label
        : undefined,
    type: "smoothstep",
    animated: false,
    selected: selected.has(edge.id),
  }));
}

function diagnosticsFor(workflow: WorkflowDefinition): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  if (!workflow.name.trim())
    diagnostics.push({ path: "name", message: "Workflow name is required.", severity: "error" });
  if (!workflow.nodes.length)
    diagnostics.push({ path: "nodes", message: "Add at least one node.", severity: "error" });
  const nodes = new Set(workflow.nodes.map((node) => node.id));
  for (const edge of workflow.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target))
      diagnostics.push({
        path: `edges.${edge.id}`,
        message: "Edge references a missing node.",
        severity: "error",
      });
    if (edge.source === edge.target)
      diagnostics.push({
        path: `edges.${edge.id}`,
        message: "A node cannot connect to itself.",
        severity: "error",
      });
  }
  const starts = workflow.nodes.filter(
    (node) => !workflow.edges.some((edge) => edge.target === node.id),
  );
  if (!starts.length)
    diagnostics.push({ path: "edges", message: "The graph has no start node.", severity: "error" });
  for (const node of workflow.nodes) {
    if (node.kind === "agent" && !node.prompt.trim())
      diagnostics.push({
        path: `nodes.${node.id}.prompt`,
        message: "Agent prompt is required.",
        severity: "error",
      });
    if (node.kind === "verify" && !node.commands.length)
      diagnostics.push({
        path: `nodes.${node.id}.commands`,
        message: "Add a verification command.",
        severity: "error",
      });
    if (node.kind === "route" && !workflow.edges.some((edge) => edge.source === node.id))
      diagnostics.push({
        path: `nodes.${node.id}`,
        message: "Route needs at least one outgoing branch.",
        severity: "warning",
      });
  }
  return diagnostics;
}

function Field({
  label,
  value,
  onChange,
  multiline = false,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  type?: string;
}) {
  const fieldId = useId();
  return (
    <div className="editor-field">
      <label htmlFor={fieldId}>{label}</label>
      {multiline ? (
        <textarea
          id={fieldId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={5}
        />
      ) : (
        <input
          id={fieldId}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

function NodeInspector({
  workflow,
  node,
  onChange,
  onDelete,
}: {
  workflow: WorkflowDefinition;
  node: WorkflowNode;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
}) {
  const update = (patch: Partial<WorkflowNode>) => onChange({ ...node, ...patch } as WorkflowNode);
  return (
    <aside className="editor-inspector" aria-label="Node configuration">
      <div className="editor-inspector__header">
        <div>
          <span className="editor-eyebrow">Configure node</span>
          <h2>{node.name}</h2>
        </div>
        <button
          type="button"
          className="editor-icon-button"
          aria-label="Delete node"
          title="Delete node"
          onClick={onDelete}
        >
          <X />
        </button>
      </div>
      <div className="editor-inspector__body">
        <Field label="Name" value={node.name} onChange={(value) => update({ name: value })} />
        <Field
          label="Description"
          value={node.description ?? ""}
          onChange={(value) => update({ description: value || undefined })}
          multiline
        />
        {node.kind === "agent" ? <AgentFields node={node} update={update} /> : null}
        {node.kind === "shell" ? <ShellFields node={node} update={update} /> : null}
        {node.kind === "verify" ? <VerifyFields node={node} update={update} /> : null}
        {node.kind === "approval" ? <ApprovalFields node={node} update={update} /> : null}
        {node.kind === "route" ? (
          <RouteFields node={node} update={update} workflow={workflow} />
        ) : null}
        {node.kind === "join" ? <JoinFields node={node} update={update} /> : null}
        {node.kind === "transform" ? <TransformFields node={node} update={update} /> : null}
        {node.kind === "shell" || node.kind === "agent" ? (
          <>
            <h3>Input bindings</h3>
            {Object.entries(node.inputBindings).map(([name, value]) => (
              <div key={name}>
                <ValueSource
                  label={name}
                  value={value}
                  workflow={workflow}
                  onChange={(value) =>
                    update({ inputBindings: { ...node.inputBindings, [name]: value } })
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    update({
                      inputBindings: Object.fromEntries(
                        Object.entries(node.inputBindings).filter(([key]) => key !== name),
                      ),
                    })
                  }
                >
                  Remove {name}
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                const key =
                  node.kind === "shell"
                    ? "stdin"
                    : `input${Object.keys(node.inputBindings).length + 1}`;
                update({
                  inputBindings: { ...node.inputBindings, [key]: { kind: "literal", value: "" } },
                });
              }}
            >
              Bind {node.kind === "shell" ? "stdin" : "an input"}
            </button>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function EdgeInspector({
  edge,
  onChange,
}: {
  edge: WorkflowEdge;
  onChange: (edge: WorkflowEdge) => void;
}) {
  const condition = edge.condition?.kind === "comparison" ? edge.condition : undefined;
  return (
    <aside className="editor-inspector" aria-label="Edge configuration">
      <div className="editor-inspector__header">
        <div>
          <span className="editor-eyebrow">Configure branch</span>
          <h2>{edge.label || "Unlabelled edge"}</h2>
        </div>
      </div>
      <div className="editor-inspector__body">
        <Field
          label="Branch label"
          value={edge.label ?? ""}
          onChange={(value) => onChange({ ...edge, label: value || undefined })}
        />
        <label className="editor-field">
          <span>Condition operator</span>
          <select
            value={condition?.operator ?? "equals"}
            onChange={(event) =>
              onChange({
                ...edge,
                condition: {
                  kind: "comparison",
                  operator: event.target.value as NonNullable<typeof condition>["operator"],
                  left: condition?.left ?? { kind: "literal", value: true },
                  right: condition?.right ?? { kind: "literal", value: true },
                },
              })
            }
          >
            <option value="equals">Equals</option>
            <option value="not_equals">Does not equal</option>
            <option value="contains">Contains</option>
            <option value="less_than">Less than</option>
            <option value="greater_than">Greater than</option>
          </select>
        </label>
        <Field
          label="Condition value"
          value={condition?.right.kind === "literal" ? String(condition.right.value ?? "") : ""}
          onChange={(value) =>
            onChange({
              ...edge,
              condition: {
                kind: "comparison",
                operator: condition?.operator ?? "equals",
                left: condition?.left ?? { kind: "literal", value: true },
                right: { kind: "literal", value },
              },
            })
          }
        />
        <p className="editor-help">
          Conditions use Loopy’s safe predicate contract. They are data, not executable code.
        </p>
      </div>
    </aside>
  );
}

function AgentFields({
  node,
  update,
}: {
  node: AgentNode;
  update: (patch: Partial<AgentNode>) => void;
}) {
  return (
    <>
      <Field
        label="Prompt"
        value={node.prompt}
        onChange={(value) => update({ prompt: value })}
        multiline
      />
      <div className="editor-field-row">
        <Field
          label="Provider"
          value={node.provider ?? ""}
          onChange={(value) => update({ provider: (value as AgentNode["provider"]) || undefined })}
        />
        <Field
          label="Model"
          value={node.model ?? ""}
          onChange={(value) => update({ model: value || undefined })}
        />
      </div>
      <div className="editor-field-row">
        <label className="editor-field">
          <span>Reasoning</span>
          <select
            value={node.reasoning ?? ""}
            onChange={(event) =>
              update({ reasoning: (event.target.value || undefined) as AgentNode["reasoning"] })
            }
          >
            <option value="">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
          </select>
        </label>
        <Field
          label="Skills"
          value={node.skills.join(", ")}
          onChange={(value) =>
            update({
              skills: value
                .split(",")
                .map((skill) => skill.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
    </>
  );
}

export function ShellFields({
  node,
  update,
}: {
  node: ShellNode;
  update: (patch: Partial<ShellNode>) => void;
}) {
  return (
    <>
      <p className="muted">
        Runs Bash on this computer in the run workspace. Each stage pipes stdout into the next.
      </p>
      {node.stages.map((stage, index) => (
        <div key={`${node.id}-${index}`}>
          <Field
            label={`Stage ${index + 1}`}
            value={stage}
            multiline
            onChange={(value) =>
              update({
                stages: node.stages.map((item, position) => (position === index ? value : item)),
              })
            }
          />
          {node.stages.length > 1 ? (
            <button
              type="button"
              onClick={() =>
                update({ stages: node.stages.filter((_, position) => position !== index) })
              }
            >
              Remove stage {index + 1}
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" onClick={() => update({ stages: [...node.stages, "cat"] })}>
        Add pipeline stage
      </button>
      <Field
        label="Timeout in milliseconds"
        value={String(node.timeoutMs)}
        onChange={(value) => {
          const timeoutMs = Number(value);
          if (Number.isInteger(timeoutMs) && timeoutMs > 0) update({ timeoutMs });
        }}
      />
      <Field
        label="Maximum attempts"
        value={String(node.retry.maxAttempts)}
        onChange={(value) => {
          const maxAttempts = Number(value);
          if (Number.isInteger(maxAttempts) && maxAttempts > 0)
            update({ retry: { ...node.retry, maxAttempts } });
        }}
      />
    </>
  );
}

export function VerifyFields({
  node,
  update,
}: {
  node: VerifyNode;
  update: (patch: Partial<VerifyNode>) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, node.commands.length - 1)));
  }, [node.commands.length]);
  const command = node.commands[selectedIndex] ?? {
    command: "",
    args: [],
    timeoutMs: 120_000,
  };
  const updateCommand = (patch: Partial<(typeof node.commands)[number]>) => {
    const commands = node.commands.map((item, index) =>
      index === selectedIndex ? { ...item, ...patch } : item,
    );
    update({ commands });
  };
  const addCommand = () => {
    update({
      // Keep the draft contract valid immediately. An empty command cannot
      // pass the node schema and would make the add action appear to do
      // nothing while silently preserving the old commands.
      commands: [...node.commands, { command: "bun", args: ["test"], timeoutMs: 120_000 }],
    });
    setSelectedIndex(node.commands.length);
  };
  const removeCommand = () => {
    if (node.commands.length <= 1) return;
    update({ commands: node.commands.filter((_, index) => index !== selectedIndex) });
    setSelectedIndex((current) => Math.min(current, node.commands.length - 2));
  };
  return (
    <>
      <div className="editor-field-row">
        <label className="editor-field">
          <span>Command to edit</span>
          <select
            aria-label="Command to edit"
            value={selectedIndex}
            onChange={(event) => setSelectedIndex(Number(event.target.value))}
          >
            {node.commands.map((item, index) => (
              <option value={index} key={`${index}-${item.command}`}>
                {index + 1}. {item.command || "Untitled command"}
              </option>
            ))}
          </select>
        </label>
        <div className="editor-field editor-field--actions">
          <span>Commands</span>
          <div>
            <button type="button" className="editor-small-button" onClick={addCommand}>
              <Plus /> Add
            </button>
            <button
              type="button"
              className="editor-small-button"
              onClick={removeCommand}
              disabled={node.commands.length <= 1}
            >
              <Minus /> Remove
            </button>
          </div>
        </div>
      </div>
      <div className="editor-field-row">
        <Field
          label="Command"
          value={command.command}
          onChange={(value) => updateCommand({ command: value })}
        />
        <Field
          label="Args"
          value={command.args.join(" ")}
          onChange={(value) => updateCommand({ args: value.split(" ").filter(Boolean) })}
        />
      </div>
      <div className="editor-field-row">
        <label className="editor-field">
          <span>Success policy</span>
          <select
            value={node.success}
            onChange={(event) => update({ success: event.target.value as VerifyNode["success"] })}
          >
            <option value="all">All commands</option>
            <option value="any">Any command</option>
          </select>
        </label>
        <Field
          label="Exit code"
          value={String(node.expectedExitCode)}
          type="number"
          onChange={(value) => update({ expectedExitCode: Number(value) || 0 })}
        />
      </div>
    </>
  );
}

function ApprovalFields({
  node,
  update,
}: {
  node: ApprovalNode;
  update: (patch: Partial<ApprovalNode>) => void;
}) {
  return (
    <>
      <Field
        label="Message"
        value={node.message}
        onChange={(value) => update({ message: value })}
        multiline
      />
      <Field
        label="Approval key"
        value={node.approvalKey}
        onChange={(value) => update({ approvalKey: value })}
      />
    </>
  );
}

function RouteFields({
  node,
  update,
  workflow,
}: {
  node: RouteNode;
  update: (patch: Partial<RouteNode>) => void;
  workflow: WorkflowDefinition;
}) {
  const predicate = node.predicate;
  if (predicate.kind !== "comparison")
    return (
      <p>
        This route uses a compound condition.{" "}
        <button
          type="button"
          onClick={() =>
            update({
              predicate: {
                kind: "comparison",
                operator: "equals",
                left: { kind: "literal", value: true },
                right: { kind: "literal", value: true },
              },
            })
          }
        >
          Use a comparison
        </button>
      </p>
    );
  return (
    <>
      <ValueSource
        label="Compare"
        value={predicate.left.kind === "reference" ? predicate.left.reference : predicate.left}
        workflow={workflow}
        onChange={(value) =>
          update({
            predicate: {
              ...predicate,
              left: value.kind === "literal" ? value : { kind: "reference", reference: value },
            },
          })
        }
      />
      <label className="editor-field">
        <span>Operator</span>
        <select
          aria-label="Condition operator"
          value={predicate.operator}
          onChange={(event) =>
            update({
              predicate: {
                ...predicate,
                operator: event.target.value as typeof predicate.operator,
              },
            })
          }
        >
          {[
            "equals",
            "not_equals",
            "contains",
            "less_than",
            "greater_than",
            "less_than_or_equal",
            "greater_than_or_equal",
          ].map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <ValueSource
        label="With"
        value={predicate.right.kind === "reference" ? predicate.right.reference : predicate.right}
        workflow={workflow}
        onChange={(value) =>
          update({
            predicate: {
              ...predicate,
              right: value.kind === "literal" ? value : { kind: "reference", reference: value },
            },
          })
        }
      />
      <p className="editor-help">
        Connect the true and false outputs to the steps that should run.
      </p>
    </>
  );
}

function JoinFields({
  node,
  update,
}: {
  node: JoinNode;
  update: (patch: Partial<JoinNode>) => void;
}) {
  return (
    <div className="editor-field-row">
      <label className="editor-field">
        <span>Join policy</span>
        <select
          value={node.policy}
          onChange={(event) => {
            const policy = event.target.value as JoinNode["policy"];
            update({ policy, ...(policy === "quorum" ? { quorum: node.quorum ?? 1 } : {}) });
          }}
        >
          <option value="all">All branches</option>
          <option value="any">Any branch</option>
          <option value="quorum">Quorum</option>
        </select>
      </label>
      {node.policy === "quorum" ? (
        <Field
          label="Quorum"
          type="number"
          value={String(node.quorum ?? 1)}
          onChange={(value) => update({ quorum: Math.max(1, Math.floor(Number(value) || 1)) })}
        />
      ) : null}
      <label className="editor-field">
        <span>Output</span>
        <select
          value={node.outputMode}
          onChange={(event) => update({ outputMode: event.target.value as JoinNode["outputMode"] })}
        >
          <option value="array">Array</option>
          <option value="object">Object</option>
          <option value="first_success">First success</option>
        </select>
      </label>
    </div>
  );
}

function TransformFields({
  node,
  update,
}: {
  node: TransformNode;
  update: (patch: Partial<TransformNode>) => void;
}) {
  return (
    <label className="editor-field">
      <span>Operation</span>
      <select
        value={node.operation}
        onChange={(event) =>
          update({ operation: event.target.value as TransformNode["operation"] })
        }
      >
        <option value="pick">Pick fields</option>
        <option value="merge">Merge values</option>
        <option value="template">Template</option>
      </select>
    </label>
  );
}

function WorkflowInputs({
  workflow,
  onChange,
}: {
  workflow: WorkflowDefinition;
  onChange: (workflow: WorkflowDefinition) => void;
}) {
  const addInput = () =>
    onChange({
      ...workflow,
      inputs: [
        ...workflow.inputs,
        {
          name: `input_${workflow.inputs.length + 1}`,
          type: "string",
          required: true,
          secret: false,
        },
      ],
    });
  return (
    <section className="editor-meta-section">
      <div className="editor-section-heading">
        <div>
          <span className="editor-eyebrow">Workflow contract</span>
          <h2>Inputs & policy</h2>
        </div>
        <button type="button" className="editor-small-button" onClick={addInput}>
          <Plus /> Add input
        </button>
      </div>
      {workflow.inputs.length ? (
        workflow.inputs.map((input, index) => (
          <div className="editor-input-row" key={`${input.name}-${index}`}>
            <input
              aria-label={`Input ${index + 1} name`}
              value={input.name}
              onChange={(event) => {
                const inputs = workflow.inputs.slice();
                inputs[index] = { ...input, name: event.target.value };
                onChange({ ...workflow, inputs });
              }}
            />
            <select
              aria-label={`Input ${index + 1} type`}
              value={input.type}
              onChange={(event) => {
                const inputs = workflow.inputs.slice();
                inputs[index] = { ...input, type: event.target.value as typeof input.type };
                onChange({ ...workflow, inputs });
              }}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="json">json</option>
              <option value="path">path</option>
              <option value="directory">directory</option>
            </select>
            <button
              type="button"
              className="editor-icon-button"
              aria-label={`Remove input ${input.name}`}
              onClick={() =>
                onChange({
                  ...workflow,
                  inputs: workflow.inputs.filter((_, inputIndex) => inputIndex !== index),
                })
              }
            >
              <Minus />
            </button>
          </div>
        ))
      ) : (
        <p className="editor-help">
          No inputs. Add one when a run should accept values from its trigger.
        </p>
      )}
      <div className="editor-policy-grid">
        <label className="editor-field">
          <span>Network</span>
          <select
            value={workflow.policies.tools.network}
            onChange={(event) =>
              onChange({
                ...workflow,
                policies: {
                  ...workflow.policies,
                  tools: {
                    ...workflow.policies.tools,
                    network: event.target.value as typeof workflow.policies.tools.network,
                  },
                },
              })
            }
          >
            <option value="disabled">Disabled</option>
            <option value="restricted">Restricted</option>
            <option value="unrestricted">Unrestricted</option>
          </select>
        </label>
        <label className="editor-field">
          <span>Max parallel</span>
          <input
            type="number"
            min="1"
            value={workflow.policies.concurrency.maxParallel}
            onChange={(event) =>
              onChange({
                ...workflow,
                policies: {
                  ...workflow.policies,
                  concurrency: {
                    ...workflow.policies.concurrency,
                    maxParallel: Math.max(1, Number(event.target.value) || 1),
                  },
                },
              })
            }
          />
        </label>
      </div>
    </section>
  );
}

function EditorCanvas(props: {
  nodes: EditorNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange<EditorNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onSelectNode: (id?: string) => void;
  onSelectEdge: (id?: string) => void;
  onClearSelection: () => void;
  onAddNode: (kind: WorkflowNode["kind"], position?: { x: number; y: number }) => void;
  onPosition: (id: string, position: { x: number; y: number }) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  return (
    <div
      className="editor-canvas"
      role="application"
      aria-label="Workflow graph editor"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const kind = event.dataTransfer.getData("application/loopy-step");
        const step = steps.find((step) => step.kind === kind);
        if (step)
          props.onAddNode(step.kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
    >
      <ReactFlow
        nodes={props.nodes}
        edges={props.edges}
        nodeTypes={nodeTypes}
        onNodesChange={props.onNodesChange}
        onEdgesChange={props.onEdgesChange}
        onConnect={props.onConnect}
        isValidConnection={(connection) =>
          connection.source !== connection.target &&
          !props.edges.some(
            (edge) =>
              edge.source === connection.source &&
              edge.target === connection.target &&
              edge.sourceHandle === connection.sourceHandle,
          )
        }
        onNodeDragStop={(_, node) => props.onPosition(node.id, node.position)}
        onNodeClick={(_, node) => props.onSelectNode(node.id)}
        onEdgeClick={(_, edge) => props.onSelectEdge(edge.id)}
        onPaneClick={props.onClearSelection}
        fitView
        fitViewOptions={{ padding: 0.22, minZoom: 0.45, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodeDragThreshold={2}
        autoPanOnNodeDrag
        autoPanSpeed={16}
        onlyRenderVisibleElements
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionRadius={28}
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "smoothstep", style: { stroke: "#747479", strokeWidth: 1.5 } }}
      >
        <Background color="#28282b" gap={24} size={1.25} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          bgColor="#101011"
          nodeColor="#b8b7b3"
          maskColor="rgba(10,10,11,0.78)"
        />
      </ReactFlow>
      {!props.nodes.length ? (
        <div className="canvas-empty">
          <strong>Add your first step</strong>
          <span>Choose an agent, a condition, or a shell module.</span>
        </div>
      ) : null}
    </div>
  );
}

function EditorToolbar({
  canUndo,
  canRedo,
  dirty,
  onUndo,
  onRedo,
  onAutoLayout,
  onImport,
  onExport,
  onValidate,
  onSave,
  onRun,
  saving,
  running,
}: {
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onValidate: () => void;
  onSave: () => void;
  onRun: () => void;
  saving: boolean;
  running: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const importInputId = useId();
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Workflow editing tools">
      <div className="editor-toolbar__group">
        <button
          type="button"
          className="editor-tool-button"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (⌘ Z)"
        >
          <ArrowLeft /> Undo
        </button>
        <button
          type="button"
          className="editor-tool-button"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (⇧ ⌘ Z)"
        >
          <ArrowRight /> Redo
        </button>
        <span className="editor-toolbar__divider" />
        <button type="button" className="editor-tool-button" onClick={onAutoLayout}>
          <MagicWand /> Auto-layout
        </button>
      </div>
      <div className="editor-toolbar__group">
        <button
          type="button"
          className="editor-tool-button"
          onClick={() => setMenu((value) => !value)}
          aria-expanded={menu}
        >
          <ArrowsClockwise /> More
        </button>
        {menu ? (
          <div className="editor-toolbar__menu">
            <button type="button" onClick={() => document.getElementById(importInputId)?.click()}>
              <UploadSimple /> Import JSON
            </button>
            <button type="button" onClick={onExport}>
              <DownloadSimple /> Export JSON
            </button>
            <input
              id={importInputId}
              type="file"
              accept="application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onImport(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
        ) : null}
        <button type="button" className="editor-tool-button" onClick={onValidate}>
          <CheckCircle /> Validate
        </button>
        <button
          type="button"
          className="editor-primary-button"
          onClick={onSave}
          disabled={!dirty || saving}
        >
          <FloppyDisk /> {saving ? "Saving…" : dirty ? "Save version" : "Saved"}
        </button>
        <button
          type="button"
          className="editor-run-button"
          onClick={onRun}
          disabled={dirty || running}
          title={dirty ? "Save changes before running" : "Run saved version"}
        >
          <Play /> {running ? "Starting…" : "Run saved"}
        </button>
      </div>
    </div>
  );
}

function VersionDiff({
  previous,
  current,
}: {
  previous: WorkflowDefinition;
  current: WorkflowDefinition;
}) {
  const diff = diffWorkflowVersions(previous, current);
  const changedFields = diff.changedWorkflowFields.map((field) =>
    field === "name"
      ? "name"
      : field === "description"
        ? "description"
        : field === "inputs"
          ? "inputs"
          : field === "defaults"
            ? "provider defaults"
            : field === "policies"
              ? "policies"
              : field,
  );
  const changedCount =
    diff.changedNodes.length + diff.changedEdges.length + (diff.workflowChanged ? 1 : 0);
  return (
    <details className="editor-diff">
      <summary>
        Version diff · {diff.addedNodes.length + diff.addedEdges.length} added ·{" "}
        {diff.removedNodes.length + diff.removedEdges.length} removed · {changedCount} changed
      </summary>
      <ul>
        {diff.addedNodes.map((node) => (
          <li className="editor-diff__add" key={`add-${node.id}`}>
            + {node.name}
          </li>
        ))}
        {diff.removedNodes.map((node) => (
          <li className="editor-diff__remove" key={`remove-${node.id}`}>
            − {node.name}
          </li>
        ))}
        {diff.changedNodes.map(({ after: node }) => (
          <li className="editor-diff__change" key={`change-${node.id}`}>
            ~ {node.name}
          </li>
        ))}
        {diff.addedEdges.map((edge) => (
          <li className="editor-diff__add" key={`add-edge-${edge.id}`}>
            + edge {edge.id}
          </li>
        ))}
        {diff.removedEdges.map((edge) => (
          <li className="editor-diff__remove" key={`remove-edge-${edge.id}`}>
            − edge {edge.id}
          </li>
        ))}
        {diff.changedEdges.map(({ after: edge }) => (
          <li className="editor-diff__change" key={`change-edge-${edge.id}`}>
            ~ edge {edge.id}
          </li>
        ))}
        {changedFields.length ? (
          <li className="editor-diff__change">~ workflow {changedFields.join(", ")}</li>
        ) : null}
      </ul>
    </details>
  );
}

export function WorkflowEditorPage({
  api,
  adapter,
}: {
  api?: ApiClient;
  adapter?: WorkflowEditorAdapter;
}) {
  const { workflowId } = useParams({ strict: false }) as { workflowId: string };
  const navigate = useNavigate();
  const [runId, setRunId] = useState<string>();
  const [runStatuses, setRunStatuses] = useState<Record<string, string>>({});
  const editorAdapter = useMemo(
    () => adapter ?? (api ? createWorkflowEditorAdapter(api) : undefined),
    [adapter, api],
  );
  const [record, setRecord] = useState<EditorWorkflowRecord>();
  const [workflow, setWorkflow] = useState<WorkflowDefinition>();
  const [previous, setPrevious] = useState<WorkflowDefinition>();
  const [nodes, setNodes] = useNodesState<EditorNode>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<EditorDiagnostic[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string>();
  const editorStoreRef = useRef<ReturnType<typeof createEditorStore> | undefined>(undefined);
  const [, setEditorTick] = useState(0);

  const attachEditorStore = useCallback(
    (store: ReturnType<typeof createEditorStore>) => {
      editorStoreRef.current = store;
      return store.subscribe((state) => {
        setWorkflow(state.document);
        setNodes(toFlowNodes(state.document, state.positions, state.selection.nodeIds));
        setEdges(toFlowEdges(state.document, state.selection.edgeIds));
        setEditorTick((tick) => tick + 1);
      });
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    setStatus("loading");
    if (!editorAdapter) {
      const value = fallbackWorkflow(workflowId);
      const store = createEditorStore(value);
      unsubscribe = attachEditorStore(store);
      setRecord({ workflowId, version: 1, definition: value });
      setWorkflow(value);
      setPrevious(value);
      setNodes(toFlowNodes(value));
      setEdges(toFlowEdges(value));
      setStatus("ready");
      return () => {
        active = false;
        unsubscribe?.();
      };
    }
    void editorAdapter
      .load(workflowId)
      .then((loaded) => {
        if (!active) return;
        setRecord(loaded);
        setWorkflow(loaded.definition);
        setPrevious(loaded.definition);
        const store = createEditorStore(loaded.definition);
        unsubscribe = attachEditorStore(store);
        setNodes(toFlowNodes(loaded.definition));
        setEdges(toFlowEdges(loaded.definition));
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setStatus("error");
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
      unsubscribe?.();
      editorStoreRef.current = undefined;
    };
  }, [attachEditorStore, editorAdapter, workflowId, setNodes, setEdges]);

  const commitWorkflow = useCallback(
    (next: WorkflowDefinition, preserveHistory = true) => {
      if (!workflow) return;
      const store = editorStoreRef.current;
      if (store) {
        store.getState().importDocument(next);
        return;
      }
      void preserveHistory;
      setWorkflow(next);
      setNodes(toFlowNodes(next));
      setEdges(toFlowEdges(next));
    },
    [setNodes, setEdges, workflow],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange<EditorNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      for (const change of changes)
        if (change.type === "remove")
          editorStoreRef.current?.getState().apply({ type: "remove_node", nodeId: change.id });
    },
    [setNodes],
  );
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes)
      if (change.type === "remove" && "id" in change)
        editorStoreRef.current?.getState().apply({ type: "remove_edge", edgeId: change.id });
  }, []);
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const edgeId = uuid();
    editorStoreRef.current?.getState().apply({
      type: "add_edge",
      edge: {
        id: edgeId,
        source: connection.source,
        ...(connection.sourceHandle ? { label: connection.sourceHandle } : {}),
        target: connection.target,
        metadata: {},
      },
    });
  }, []);
  const selectNode = useCallback((id?: string) => {
    editorStoreRef.current?.getState().selectNodes(id ? [id] : []);
    setSelectedNodeId(id);
    setSelectedEdgeId(undefined);
  }, []);
  const selectEdge = useCallback((id?: string) => {
    editorStoreRef.current?.getState().selectEdges(id ? [id] : []);
    setSelectedEdgeId(id);
    setSelectedNodeId(undefined);
  }, []);
  const clearSelection = useCallback(() => {
    editorStoreRef.current?.getState().clearSelection();
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
  }, []);
  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId);
  const dirty = Boolean(
    workflow && previous && JSON.stringify(workflow) !== JSON.stringify(previous),
  );
  const updateNode = (nextNode: WorkflowNode) => {
    if (!workflow || !selectedNode) return;
    const { id, kind: _kind, ...patch } = nextNode;
    editorStoreRef.current?.getState().apply({
      type: "update_node",
      nodeId: id,
      patch: patch as EditorNodePatch,
    });
  };
  const updateEdge = (nextEdge: WorkflowEdge) => {
    if (!workflow) return;
    const { id, source: _source, target: _target, ...patch } = nextEdge;
    editorStoreRef.current?.getState().apply({
      type: "update_edge",
      edgeId: id,
      patch,
    });
  };
  const deleteNode = () => {
    if (!workflow || !selectedNodeId) return;
    editorStoreRef.current?.getState().apply({ type: "remove_node", nodeId: selectedNodeId });
    setSelectedNodeId(undefined);
  };
  const addNode = (kind: WorkflowNode["kind"], position?: { x: number; y: number }) => {
    if (!workflow) return;
    const id = uuid();
    const base = {
      id,
      position: position ?? {
        x: 80 + workflow.nodes.length * 80,
        y: 120 + workflow.nodes.length * 40,
      },
      name: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} step`,
      tags: [],
    };
    let node: WorkflowNode;
    if (kind === "agent")
      node = {
        ...base,
        kind,
        prompt: "Describe the work this agent should complete.",
        provider: workflow.defaults.provider,
        skills: [],
        inputBindings: {},
        requiredCapabilities: [],
        completionContract: "node_completion",
      };
    else if (kind === "shell")
      node = {
        ...base,
        kind,
        stages: ["cat"],
        inputBindings: {},
        execution: "host",
        timeoutMs: 120_000,
        maxOutputBytes: 1_048_576,
        retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
        sideEffect: true,
      };
    else if (kind === "verify")
      node = {
        ...base,
        kind,
        commands: [{ command: "bun", args: ["test"], timeoutMs: 120_000 }],
        success: "all",
        expectedExitCode: 0,
      };
    else if (kind === "approval")
      node = { ...base, kind, message: "Review before continuing.", approvalKey: "approval" };
    else if (kind === "route")
      node = {
        ...base,
        kind,
        predicate: {
          kind: "comparison",
          operator: "equals",
          left: { kind: "literal", value: true },
          right: { kind: "literal", value: true },
        },
      };
    else if (kind === "join") node = { ...base, kind, policy: "all", outputMode: "array" };
    else node = { ...base, kind, operation: "pick", mapping: {} };
    editorStoreRef.current?.getState().apply({ type: "add_node", node, position: node.position });
    setSelectedNodeId(id);
  };
  const autoLayout = () => {
    editorStoreRef.current?.getState().autoLayout();
    setNotice("Layout arranged. Save the version to keep these positions.");
  };
  const validate = async () => {
    const store = editorStoreRef.current;
    const submittedRevision = store?.getState().revision ?? 0;
    const current = structuredClone(workflow ?? fallbackWorkflow(workflowId));
    setError(undefined);
    try {
      const result = editorAdapter
        ? await editorAdapter.validate(current)
        : {
            valid: diagnosticsFor(current).every((item) => item.severity !== "error"),
            diagnostics: diagnosticsFor(current),
          };
      const accepted = store?.getState().applyValidation(result, submittedRevision) ?? true;
      if (!accepted) {
        setNotice("Validation result discarded because the draft changed while it was running.");
        return;
      }
      const diagnostics = (result.diagnostics ?? []).map((item) => ({
        path: item.path ?? "workflow",
        message: item.message,
        severity: item.severity ?? "error",
      }));
      setDiagnostics(diagnostics);
      setNotice(
        diagnostics.length
          ? `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} found.`
          : "Workflow is valid for local editing.",
      );
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const undo = () => {
    editorStoreRef.current?.getState().undo();
  };
  const redo = () => {
    editorStoreRef.current?.getState().redo();
  };
  const save = useCallback(async () => {
    if (!workflow || !record || !editorAdapter) {
      setNotice("No persistence adapter is connected; changes remain local.");
      return;
    }
    const store = editorStoreRef.current;
    const submittedRevision = store?.getState().revision ?? 0;
    const submittedWorkflow = structuredClone(store?.getState().document ?? workflow);
    const errors = diagnosticsFor(submittedWorkflow).filter((item) => item.severity === "error");
    setDiagnostics(errors);
    if (errors.length) {
      setNotice("Fix blocking diagnostics before saving.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const saved = await editorAdapter.save({
        workflowId: record.workflowId,
        baseVersion: record.version,
        definition: submittedWorkflow,
        summary: `${submittedWorkflow.nodes.length} nodes · ${submittedWorkflow.edges.length} edges`,
      });
      setRecord(saved);
      setPrevious(saved.definition);
      const preserved = store
        ? !store.getState().resetIfRevision(saved.definition, submittedRevision)
        : false;
      setNotice(
        preserved
          ? `Saved version ${saved.version}; later edits remain unsaved.`
          : `Saved version ${saved.version}.`,
      );
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [editorAdapter, record, workflow]);
  const run = async (input: Record<string, unknown> = {}) => {
    if (!record || !editorAdapter || dirty) return;
    setRunning(true);
    setError(undefined);
    try {
      const result = await editorAdapter.run(record.workflowId, record.version, input);
      setNotice(`Run ${result.id} started from version ${record.version}.`);
      setRunId(result.id);
      setRunStatuses({});
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editableTarget = Boolean(
        target?.isContentEditable ||
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.tagName === "SELECT",
      );
      const intent = keyboardIntent(event, { editableTarget });
      if (!intent) return;
      let handled = true;
      const store = editorStoreRef.current?.getState();
      if (!store) return;
      switch (intent) {
        case "undo":
          handled = store.undo();
          break;
        case "redo":
          handled = store.redo();
          break;
        case "save":
          void save();
          break;
        case "delete":
          if (selectedNodeId) {
            store.apply({ type: "remove_node", nodeId: selectedNodeId });
            setSelectedNodeId(undefined);
          } else if (selectedEdgeId) {
            store.apply({ type: "remove_edge", edgeId: selectedEdgeId });
            setSelectedEdgeId(undefined);
          } else {
            handled = false;
          }
          break;
        case "select_all":
          store.selectNodes(workflow?.nodes.map((node) => node.id) ?? []);
          setSelectedNodeId(workflow?.nodes[0]?.id);
          setSelectedEdgeId(undefined);
          break;
        case "clear_selection":
          store.clearSelection();
          setSelectedNodeId(undefined);
          setSelectedEdgeId(undefined);
          break;
        case "auto_layout":
          store.autoLayout();
          setNotice("Layout arranged. Save the version to keep these positions.");
          break;
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workflow, selectedNodeId, selectedEdgeId, save]);
  const exportWorkflow = () => {
    if (!workflow) return;
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "workflow"}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const importWorkflow = async (file: File) => {
    try {
      setError(undefined);
      const store = editorStoreRef.current;
      if (!store) throw new Error("The editor is not ready to import a workflow.");
      const imported = store.getState().importDocument(await file.text());
      if (!imported.ok) {
        const importedDiagnostics = imported.diagnostics.map((item) => ({
          path: item.path ?? "workflow",
          message: item.message,
          severity: item.severity ?? "error",
        }));
        setDiagnostics(importedDiagnostics);
        setNotice(
          `Import rejected: ${importedDiagnostics.length} diagnostic${importedDiagnostics.length === 1 ? "" : "s"} found.`,
        );
        return;
      }
      setDiagnostics([]);
      setNotice("Imported workflow as unsaved local changes.");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (status === "loading") return <LoadingState label="Loading workflow editor" />;
  if (status === "error" || !workflow)
    return <ErrorState message={error ?? "Workflow could not be loaded."} />;
  return (
    <ReactFlowProvider>
      <PageEditorLayout
        workflow={workflow}
        record={record}
        dirty={dirty}
        diagnostics={diagnostics}
        notice={notice}
        error={error}
        selectedNode={selectedNode}
        selectedEdgeId={selectedEdgeId}
        nodes={nodes.map((node) => ({
          ...node,
          data: { ...node.data, runStatus: runStatuses[node.id] },
        }))}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectNode={selectNode}
        onSelectEdge={selectEdge}
        onClearSelection={clearSelection}
        canUndo={Boolean(editorStoreRef.current?.getState().history.past.length)}
        canRedo={Boolean(editorStoreRef.current?.getState().history.future.length)}
        onUndo={undo}
        onRedo={redo}
        onAutoLayout={autoLayout}
        onImport={importWorkflow}
        onExport={exportWorkflow}
        onValidate={validate}
        onSave={() => void save()}
        onRun={(input) => void run(input)}
        saving={saving}
        running={running}
        onWorkflowChange={(next) => commitWorkflow(next)}
        onNodeChange={updateNode}
        onEdgeChange={updateEdge}
        onDeleteNode={deleteNode}
        onAddNode={addNode}
        previous={previous}
        onBack={() => void navigate({ to: "/workflows" })}
        onPosition={(id, position) => editorStoreRef.current?.getState().setPosition(id, position)}
        console={
          api && runId ? (
            <RunConsole api={api} runId={runId} onStatuses={setRunStatuses} />
          ) : undefined
        }
      />
    </ReactFlowProvider>
  );
}

function PageEditorLayout(props: {
  workflow: WorkflowDefinition;
  record?: EditorWorkflowRecord;
  dirty: boolean;
  diagnostics: EditorDiagnostic[];
  notice?: string;
  error?: string;
  selectedNode?: WorkflowNode;
  selectedEdgeId?: string;
  nodes: EditorNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange<EditorNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onSelectNode: (id?: string) => void;
  onSelectEdge: (id?: string) => void;
  onClearSelection: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onValidate: () => void;
  onSave: () => void;
  onRun: (input?: Record<string, unknown>) => void;
  saving: boolean;
  running: boolean;
  onWorkflowChange: (workflow: WorkflowDefinition) => void;
  onNodeChange: (node: WorkflowNode) => void;
  onEdgeChange: (edge: WorkflowEdge) => void;
  onDeleteNode: () => void;
  onAddNode: (kind: WorkflowNode["kind"], position?: { x: number; y: number }) => void;
  onPosition: (id: string, position: { x: number; y: number }) => void;
  onBack: () => void;
  console?: React.ReactNode;
  previous?: WorkflowDefinition;
}) {
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inputsOpen, setInputsOpen] = useState(false);
  const [inputError, setInputError] = useState<string>();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const startRun = () => {
    if (props.workflow.inputs.length) setInputsOpen(true);
    else props.onRun();
  };
  return (
    <section className="builder-shell" aria-label="Workflow editor">
      <header className="builder-header">
        <div className="builder-header-left">
          <button
            type="button"
            className="builder-icon-button"
            aria-label="Back to workflows"
            onClick={props.onBack}
          >
            <ArrowLeft />
          </button>
          <span className="builder-mark">L</span>
          <div className="builder-title">
            <input
              aria-label="Workflow name"
              value={props.workflow.name}
              onChange={(event) =>
                props.onWorkflowChange({ ...props.workflow, name: event.target.value })
              }
            />
            <span className="editor-save-status">
              {props.dirty ? "Unsaved" : `v${props.record?.version ?? 1}`}
            </span>
          </div>
        </div>
        <div className="builder-header-right">
          <button
            type="button"
            className="builder-tool-button"
            aria-pressed={paletteOpen}
            onClick={() => setPaletteOpen(!paletteOpen)}
          >
            Step library
          </button>
          <button
            type="button"
            className="builder-tool-button"
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            Inspector
          </button>
        </div>
      </header>
      <EditorToolbar {...props} onRun={startRun} />
      <div
        className={`builder-workspace ${paletteOpen ? "with-library" : ""} ${inspectorOpen ? "with-inspector" : ""}`}
      >
        {paletteOpen ? <StepLibrary onAdd={props.onAddNode} /> : null}
        <div className="builder-canvas">
          <EditorCanvas {...props} />
          {props.console}
        </div>
        {inspectorOpen ? (
          props.selectedNode ? (
            <NodeInspector
              workflow={props.workflow}
              node={props.selectedNode}
              onChange={props.onNodeChange}
              onDelete={props.onDeleteNode}
            />
          ) : props.selectedEdgeId ? (
            (() => {
              const edge = props.workflow.edges.find(
                (candidate) => candidate.id === props.selectedEdgeId,
              );
              return edge ? <EdgeInspector edge={edge} onChange={props.onEdgeChange} /> : null;
            })()
          ) : (
            <aside className="editor-inspector" aria-label="Workflow settings">
              <header className="editor-inspector__header">
                <span className="editor-eyebrow">Workflow settings</span>
              </header>
              <div className="editor-inspector__body">
                <Field
                  label="Description"
                  value={props.workflow.description ?? ""}
                  multiline
                  onChange={(description) =>
                    props.onWorkflowChange({ ...props.workflow, description })
                  }
                />
                <WorkflowInputs workflow={props.workflow} onChange={props.onWorkflowChange} />
                {props.previous && props.dirty ? (
                  <VersionDiff previous={props.previous} current={props.workflow} />
                ) : null}
              </div>
            </aside>
          )
        ) : null}
      </div>
      {inputsOpen ? (
        <div className="builder-modal">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const input: Record<string, unknown> = {};
              try {
                for (const field of props.workflow.inputs) {
                  const value = inputValues[field.name];
                  if (value === undefined || value === "") continue;
                  input[field.name] = field.type === "string" ? value : JSON.parse(value);
                }
                props.onRun(input);
                setInputsOpen(false);
              } catch {
                setInputError("Use valid JSON for numbers, booleans, arrays, and objects.");
              }
            }}
          >
            <h2>Run inputs</h2>
            {inputError ? <p role="alert">{inputError}</p> : null}
            {props.workflow.inputs.map((input) => (
              <label key={input.name}>
                {input.name}
                <input
                  required={input.required}
                  aria-label={input.name}
                  placeholder={input.type}
                  value={inputValues[input.name] ?? ""}
                  onChange={(event) =>
                    setInputValues({ ...inputValues, [input.name]: event.target.value })
                  }
                />
              </label>
            ))}
            <button type="button" onClick={() => setInputsOpen(false)}>
              Cancel
            </button>
            <button type="submit">Start run</button>
          </form>
        </div>
      ) : null}
      {props.diagnostics.length ? (
        <section className="editor-diagnostics" aria-label="Workflow diagnostics">
          <div className="editor-diagnostics__heading">
            <WarningCircle /> Diagnostics <span>{props.diagnostics.length}</span>
          </div>
          <ul>
            {props.diagnostics.map((diagnostic) => (
              <li
                key={`${diagnostic.path}-${diagnostic.message}`}
                className={`editor-diagnostic--${diagnostic.severity}`}
              >
                <strong>{diagnostic.path}</strong> {diagnostic.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.notice ? <output className="editor-notice">{props.notice}</output> : null}
      {props.error ? (
        <div className="editor-notice editor-notice--error" role="alert">
          {props.error}
        </div>
      ) : null}
    </section>
  );
}

export { WorkflowNodeCard, diagnosticsFor, fallbackWorkflow, toFlowEdges, toFlowNodes };
