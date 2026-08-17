import type {
  AgentNode,
  ApprovalNode,
  JoinNode,
  RouteNode,
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
  addEdge,
  Background,
  type Connection,
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
} from "@xyflow/react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ApiClient } from "../app/api";
import { ErrorState, LoadingState } from "../components/primitives/states";

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
      const versions = await api.request<unknown>(
        `/workflows/${encodeURIComponent(workflowId)}/${version ?? 1}`,
      );
      const record = asWorkflow(versions);
      if (!record) throw new Error("The local API returned an invalid workflow version.");
      return record;
    },
    async save({ workflowId, baseVersion, definition, summary }) {
      void baseVersion;
      void summary;
      const result = await api.request<unknown>("/workflows", {
        method: "POST",
        body: JSON.stringify({
          workflowId,
          version: baseVersion + 1,
          definition: { ...definition, workflowVersion: baseVersion + 1 },
        }),
      });
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
  };
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

type EditorNodeData = { workflowNode: WorkflowNode; position?: { x: number; y: number } };
type EditorNode = Node<EditorNodeData, "workflow">;

const kindColors: Record<WorkflowNode["kind"], string> = {
  agent: "#f3a946",
  verify: "#56c897",
  approval: "#d9a7ff",
  route: "#80b8ff",
  join: "#ff9f7a",
  transform: "#c5d478",
};

function nodeSubtitle(node: WorkflowNode): string {
  if (node.kind === "agent")
    return `${node.provider ?? "default provider"}${node.model ? ` · ${node.model}` : ""}`;
  if (node.kind === "verify")
    return `${node.commands.length} command${node.commands.length === 1 ? "" : "s"}`;
  if (node.kind === "approval") return "human checkpoint";
  if (node.kind === "route")
    return node.defaultRoute ? `default → ${node.defaultRoute}` : "conditional branch";
  if (node.kind === "join") return `${node.policy} / ${node.outputMode}`;
  return node.operation;
}

function WorkflowNodeCard({ data, selected }: { data: EditorNodeData; selected?: boolean }) {
  const color = kindColors[data.workflowNode.kind];
  return (
    <button
      type="button"
      className={`workflow-node-card${selected ? " workflow-node-card--selected" : ""}`}
      style={{ "--node-accent": color } as React.CSSProperties}
      aria-label={`${data.workflowNode.name} ${data.workflowNode.kind} node`}
    >
      <Handle type="target" position={Position.Left} className="workflow-handle" />
      <div className="workflow-node-card__kind">
        <span className="workflow-node-card__dot" />
        {data.workflowNode.kind}
      </div>
      <strong>{data.workflowNode.name}</strong>
      <span>{nodeSubtitle(data.workflowNode)}</span>
      <Handle type="source" position={Position.Right} className="workflow-handle" />
    </button>
  );
}

const nodeTypes = { workflow: WorkflowNodeCard };

function toFlowNodes(workflow: WorkflowDefinition): EditorNode[] {
  return workflow.nodes.map((workflowNode, index) => ({
    id: workflowNode.id,
    type: "workflow",
    position: { x: 80 + (index % 3) * 250, y: 90 + Math.floor(index / 3) * 150 },
    data: { workflowNode },
  }));
}

function toFlowEdges(workflow: WorkflowDefinition): Edge[] {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    data: { workflowEdge: edge },
    type: "default",
    animated: false,
  }));
}

function fromFlow(
  nodes: EditorNode[],
  edges: Edge[],
  previous: WorkflowDefinition,
): WorkflowDefinition {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...previous,
    nodes: nodes.map((node) => node.data.workflowNode),
    edges: edges
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(typeof edge.label === "string" && edge.label.trim() ? { label: edge.label } : {}),
        ...(edge.data && typeof edge.data === "object" && "workflowEdge" in edge.data
          ? { condition: (edge.data as { workflowEdge: WorkflowEdge }).workflowEdge.condition }
          : {}),
        metadata:
          (edge.data as { workflowEdge?: WorkflowEdge } | undefined)?.workflowEdge?.metadata ?? {},
      })),
    metadata: { ...previous.metadata, updatedAt: now() },
  };
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
  node,
  onChange,
  onDelete,
}: {
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
        {node.kind === "verify" ? <VerifyFields node={node} update={update} /> : null}
        {node.kind === "approval" ? <ApprovalFields node={node} update={update} /> : null}
        {node.kind === "route" ? <RouteFields node={node} update={update} /> : null}
        {node.kind === "join" ? <JoinFields node={node} update={update} /> : null}
        {node.kind === "transform" ? <TransformFields node={node} update={update} /> : null}
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

function VerifyFields({
  node,
  update,
}: {
  node: VerifyNode;
  update: (patch: Partial<VerifyNode>) => void;
}) {
  const command = node.commands[0] ?? { command: "", args: [], timeoutMs: 120_000 };
  return (
    <>
      <div className="editor-field-row">
        <Field
          label="Command"
          value={command.command}
          onChange={(value) => update({ commands: [{ ...command, command: value }] })}
        />
        <Field
          label="Args"
          value={command.args.join(" ")}
          onChange={(value) =>
            update({ commands: [{ ...command, args: value.split(" ").filter(Boolean) }] })
          }
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
}: {
  node: RouteNode;
  update: (patch: Partial<RouteNode>) => void;
}) {
  return (
    <>
      <Field
        label="Default branch label"
        value={node.defaultRoute ?? ""}
        onChange={(value) => update({ defaultRoute: value || undefined })}
      />
      <p className="editor-help">
        Edit each edge label in the graph by selecting it. Conditions remain closed data, never
        executable source.
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
          onChange={(event) => update({ policy: event.target.value as JoinNode["policy"] })}
        >
          <option value="all">All branches</option>
          <option value="any">Any branch</option>
          <option value="quorum">Quorum</option>
        </select>
      </label>
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

function EditorCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectNode,
  onSelectEdge,
}: {
  nodes: EditorNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange<EditorNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onSelectNode: (id?: string) => void;
  onSelectEdge: (id?: string) => void;
}) {
  return (
    <div className="editor-canvas" role="application" aria-label="Workflow graph editor">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => {
          onSelectNode(undefined);
          onSelectEdge(undefined);
        }}
        fitView
        minZoom={0.45}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#2d3138" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => kindColors[(node.data as EditorNodeData).workflowNode.kind]}
          maskColor="#111214cc"
        />
      </ReactFlow>
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
  const added = current.nodes.filter((node) => !previous.nodes.some((old) => old.id === node.id));
  const removed = previous.nodes.filter(
    (node) => !current.nodes.some((next) => next.id === node.id),
  );
  const changed = current.nodes.filter((node) => {
    const old = previous.nodes.find((candidate) => candidate.id === node.id);
    return old && JSON.stringify(old) !== JSON.stringify(node);
  });
  return (
    <details className="editor-diff">
      <summary>
        Version diff · {added.length} added · {removed.length} removed · {changed.length} changed
      </summary>
      <ul>
        {added.map((node) => (
          <li className="editor-diff__add" key={`add-${node.id}`}>
            + {node.name}
          </li>
        ))}
        {removed.map((node) => (
          <li className="editor-diff__remove" key={`remove-${node.id}`}>
            − {node.name}
          </li>
        ))}
        {changed.map((node) => (
          <li className="editor-diff__change" key={`change-${node.id}`}>
            ~ {node.name}
          </li>
        ))}
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
  const [history, setHistory] = useState<WorkflowDefinition[]>([]);
  const [future, setFuture] = useState<WorkflowDefinition[]>([]);
  const [diagnostics, setDiagnostics] = useState<EditorDiagnostic[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let active = true;
    setStatus("loading");
    if (!editorAdapter) {
      const value = fallbackWorkflow(workflowId);
      setRecord({ workflowId, version: 1, definition: value });
      setWorkflow(value);
      setPrevious(value);
      setNodes(toFlowNodes(value));
      setEdges(toFlowEdges(value));
      setStatus("ready");
      return () => {
        active = false;
      };
    }
    void editorAdapter
      .load(workflowId)
      .then((loaded) => {
        if (!active) return;
        setRecord(loaded);
        setWorkflow(loaded.definition);
        setPrevious(loaded.definition);
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
    };
  }, [editorAdapter, workflowId, setNodes, setEdges]);

  const commitWorkflow = useCallback(
    (next: WorkflowDefinition, preserveHistory = true) => {
      if (!workflow) return;
      if (preserveHistory) {
        setHistory((items) => [...items.slice(-49), workflow]);
        setFuture([]);
      }
      setWorkflow(next);
      setNodes(toFlowNodes(next));
      setEdges(toFlowEdges(next));
    },
    [setNodes, setEdges, workflow],
  );
  const syncGraph = useCallback(
    (nextNodes: EditorNode[], nextEdges: Edge[]) => {
      if (!workflow) return;
      const next = fromFlow(nextNodes, nextEdges, workflow);
      setWorkflow(next);
    },
    [workflow],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange<EditorNode>[]) => {
      setNodes((current) => {
        const next = current.map((node) => {
          const change = changes.find((candidate) => "id" in candidate && candidate.id === node.id);
          if (change?.type === "position" && change.position)
            return { ...node, position: change.position };
          return node;
        });
        queueMicrotask(() => syncGraph(next, edges));
        return next;
      });
    },
    [edges, setNodes, syncGraph],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((current) => {
        const next = current.filter(
          (edge) =>
            !changes.some(
              (change) => change.type === "remove" && "id" in change && change.id === edge.id,
            ),
        );
        queueMicrotask(() => syncGraph(nodes, next));
        return next;
      });
    },
    [nodes, setEdges, syncGraph],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const edge: Edge = {
        id: uuid(),
        source: connection.source,
        target: connection.target,
        data: {
          workflowEdge: {
            id: uuid(),
            source: connection.source,
            target: connection.target,
            metadata: {},
          },
        },
      };
      const nextEdges = addEdge(edge, edges);
      setEdges(nextEdges);
      if (workflow) setWorkflow(fromFlow(nodes, nextEdges, workflow));
    },
    [edges, nodes, setEdges, workflow],
  );
  const selectedNode = workflow?.nodes.find((node) => node.id === selectedNodeId);
  const dirty = Boolean(
    workflow && previous && JSON.stringify(workflow) !== JSON.stringify(previous),
  );
  const updateNode = (nextNode: WorkflowNode) => {
    if (!workflow || !selectedNode) return;
    commitWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((node) => (node.id === nextNode.id ? nextNode : node)),
    });
  };
  const updateEdge = (nextEdge: WorkflowEdge) => {
    if (!workflow) return;
    commitWorkflow({
      ...workflow,
      edges: workflow.edges.map((edge) => (edge.id === nextEdge.id ? nextEdge : edge)),
    });
  };
  const deleteNode = () => {
    if (!workflow || !selectedNodeId) return;
    commitWorkflow({
      ...workflow,
      nodes: workflow.nodes.filter((node) => node.id !== selectedNodeId),
      edges: workflow.edges.filter(
        (edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId,
      ),
    });
    setSelectedNodeId(undefined);
  };
  const addNode = (kind: WorkflowNode["kind"]) => {
    if (!workflow) return;
    const id = uuid();
    const base = { id, name: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} step`, tags: [] };
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
    commitWorkflow({ ...workflow, nodes: [...workflow.nodes, node] });
    setSelectedNodeId(id);
  };
  const autoLayout = () => {
    setNodes((current) =>
      current.map((node, index) => ({
        ...node,
        position: { x: 80 + (index % 3) * 250, y: 90 + Math.floor(index / 3) * 150 },
      })),
    );
    setNotice("Layout arranged for editing; positions are local to this Studio view.");
  };
  const validate = () => {
    const result = diagnosticsFor(workflow ?? fallbackWorkflow(workflowId));
    setDiagnostics(result);
    setNotice(
      result.length
        ? `${result.length} diagnostic${result.length === 1 ? "" : "s"} found.`
        : "Workflow is valid for local editing.",
    );
  };
  const undo = () => {
    const old = history.at(-1);
    if (!old || !workflow) return;
    setFuture((items) => [...items, workflow]);
    setHistory((items) => items.slice(0, -1));
    setWorkflow(old);
    setNodes(toFlowNodes(old));
    setEdges(toFlowEdges(old));
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next || !workflow) return;
    setHistory((items) => [...items, workflow]);
    setFuture((items) => items.slice(0, -1));
    setWorkflow(next);
    setNodes(toFlowNodes(next));
    setEdges(toFlowEdges(next));
  };
  const save = async () => {
    if (!workflow || !record || !editorAdapter) {
      setNotice("No persistence adapter is connected; changes remain local.");
      return;
    }
    const errors = diagnosticsFor(workflow).filter((item) => item.severity === "error");
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
        definition: workflow,
        summary: `${workflow.nodes.length} nodes · ${workflow.edges.length} edges`,
      });
      setRecord(saved);
      setPrevious(saved.definition);
      setWorkflow(saved.definition);
      setNodes(toFlowNodes(saved.definition));
      setEdges(toFlowEdges(saved.definition));
      setHistory([]);
      setFuture([]);
      setNotice(`Saved version ${saved.version}.`);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const run = async () => {
    if (!record || !editorAdapter || dirty) return;
    setRunning(true);
    setError(undefined);
    try {
      const result = await editorAdapter.run(record.workflowId, record.version);
      setNotice(`Run ${result.id} started from version ${record.version}.`);
      void navigate({ to: "/runs" });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };
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
      const parsed = JSON.parse(await file.text()) as WorkflowDefinition;
      if (!parsed || parsed.schemaVersion !== "1" || !Array.isArray(parsed.nodes))
        throw new Error("Imported file is not a Loopy workflow definition.");
      commitWorkflow(parsed);
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
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectNode={setSelectedNodeId}
        onSelectEdge={setSelectedEdgeId}
        canUndo={history.length > 0}
        canRedo={future.length > 0}
        onUndo={undo}
        onRedo={redo}
        onAutoLayout={autoLayout}
        onImport={importWorkflow}
        onExport={exportWorkflow}
        onValidate={validate}
        onSave={() => void save()}
        onRun={() => void run()}
        saving={saving}
        running={running}
        onWorkflowChange={(next) => commitWorkflow(next)}
        onNodeChange={updateNode}
        onEdgeChange={updateEdge}
        onDeleteNode={deleteNode}
        onAddNode={addNode}
        previous={previous}
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
  canUndo: boolean;
  canRedo: boolean;
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
  onWorkflowChange: (workflow: WorkflowDefinition) => void;
  onNodeChange: (node: WorkflowNode) => void;
  onEdgeChange: (edge: WorkflowEdge) => void;
  onDeleteNode: () => void;
  onAddNode: (kind: WorkflowNode["kind"]) => void;
  previous?: WorkflowDefinition;
}) {
  const [addMenu, setAddMenu] = useState(false);
  return (
    <section className="workflow-editor-page" aria-label="Workflow editor">
      <header className="workflow-editor-header">
        <div>
          <div className="editor-breadcrumb">
            <GitBranch /> Build / Workflows / {props.workflow.name}
          </div>
          <div className="workflow-editor-title-row">
            <input
              aria-label="Workflow name"
              value={props.workflow.name}
              onChange={(event) =>
                props.onWorkflowChange({ ...props.workflow, name: event.target.value })
              }
            />
            <span
              className={`editor-save-status${props.dirty ? " editor-save-status--dirty" : ""}`}
            >
              {props.dirty
                ? "Unsaved changes"
                : `v${props.record?.version ?? props.workflow.workflowVersion}`}
            </span>
          </div>
        </div>
        <div className="workflow-editor-header__actions">
          <button
            type="button"
            className="editor-small-button"
            onClick={() => setAddMenu((value) => !value)}
            aria-expanded={addMenu}
          >
            <Plus /> Add node
          </button>
          {addMenu ? (
            <div className="editor-add-menu">
              {(["agent", "verify", "approval", "route", "join", "transform"] as const).map(
                (kind) => (
                  <button
                    type="button"
                    key={kind}
                    onClick={() => {
                      props.onAddNode(kind);
                      setAddMenu(false);
                    }}
                  >
                    {kind}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      </header>
      <EditorToolbar {...props} />
      <div className="workflow-editor-body">
        <div className="workflow-editor-main">
          <EditorCanvas {...props} />
          <div className="workflow-editor-meta">
            <WorkflowInputs workflow={props.workflow} onChange={props.onWorkflowChange} />
            {props.previous && props.dirty ? (
              <VersionDiff previous={props.previous} current={props.workflow} />
            ) : null}
          </div>
        </div>
        {props.selectedNode ? (
          <NodeInspector
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
          <aside className="editor-inspector editor-inspector--empty">
            <span className="editor-eyebrow">Inspector</span>
            <h2>Select a node</h2>
            <p>
              Choose a node in the graph to configure its provider, prompt, verification, or control
              policy.
            </p>
          </aside>
        )}
      </div>
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
