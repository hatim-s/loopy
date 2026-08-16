import type {
  ExecutionPlan as ContractExecutionPlan,
  ExecutionTopology as ContractExecutionTopology,
  WorkflowDefinition as ContractWorkflowDefinition,
  WorkflowEdge as ContractWorkflowEdge,
  WorkflowNode as ContractWorkflowNode,
} from "@loopy/contracts";
import { WorkflowDefinitionSchema } from "@loopy/contracts";

/** Public workflow types are owned by @loopy/contracts. */
export type WorkflowDefinition = ContractWorkflowDefinition;
export type WorkflowNode = ContractWorkflowNode;
export type WorkflowEdge = ContractWorkflowEdge;
/** A fully materialized, provider-bound plan persisted by a later runtime phase. */
export type ExecutionPlan = ContractExecutionPlan;

type RawRecord = Record<string, unknown>;

export type DiagnosticSeverity = "error" | "warning";

export type DiagnosticCode =
  | "WORKFLOW_NOT_OBJECT"
  | "NODES_NOT_ARRAY"
  | "EDGES_NOT_ARRAY"
  | "NODE_ID_INVALID"
  | "DUPLICATE_NODE_ID"
  | "EDGE_ID_INVALID"
  | "DUPLICATE_EDGE_ID"
  | "NODE_KIND_INVALID"
  | "EDGE_SOURCE_INVALID"
  | "EDGE_TARGET_INVALID"
  | "EDGE_ENDPOINT_MISSING"
  | "START_NODE_INVALID"
  | "START_NODE_MISSING"
  | "MULTIPLE_START_NODES"
  | "NODE_UNREACHABLE"
  | "DISCONNECTED_SUBGRAPH"
  | "NO_REACHABLE_TERMINAL"
  | "CYCLE_UNSUPPORTED"
  | "ROUTE_LABEL_REQUIRED"
  | "ROUTE_LABEL_UNEXPECTED"
  | "ROUTE_LABEL_DUPLICATE"
  | "ROUTE_OUTGOING_INCONSISTENT"
  | "JOIN_INCOMING_REQUIRED"
  | "JOIN_POLICY_REQUIRED"
  | "JOIN_POLICY_INVALID"
  | "JOIN_POLICY_SHAPE_INVALID"
  | "NODE_REQUIRED_FIELD"
  | "NODE_FIELD_INVALID"
  | "UNSUPPORTED_NODE_KIND"
  | "WORKFLOW_INPUT_REFERENCE_INVALID"
  | "NODE_OUTPUT_REFERENCE_TARGET_MISSING"
  | "NODE_OUTPUT_REFERENCE_SELF"
  | "NODE_OUTPUT_REFERENCE_NOT_UPSTREAM"
  | "WORKFLOW_CONTRACT_INVALID";

export type WorkflowDiagnostic = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** JSON Pointer into the supplied workflow, e.g. `/nodes/1/id`. */
  path: string;
  /** Structured counterpart useful to callers that do not parse JSON Pointer. */
  pathSegments: Array<string | number>;
  nodeId?: string;
  edgeId?: string;
};

export type WorkflowValidationResult = {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
  graph: NormalizedWorkflowGraph;
};

export type NormalizedWorkflowNode = {
  id: string;
  kind: string;
  index: number;
  value: RawRecord;
};

export type NormalizedWorkflowEdge = {
  id: string;
  source: string;
  target: string;
  index: number;
  route?: string;
  condition?: unknown;
  value: RawRecord;
};

export type NormalizedWorkflowGraph = {
  nodes: NormalizedWorkflowNode[];
  edges: NormalizedWorkflowEdge[];
  startNodeIds: string[];
  terminalNodeIds: string[];
  reachableNodeIds: string[];
  topologicalOrder: string[];
};

/**
 * Phase 0's graph-only preparation result. It deliberately carries the
 * persisted contract's identity/version/topology vocabulary, while leaving
 * plan hashing, provider installations, bindings, policies, and warnings to
 * the phase that materializes an ExecutionPlan.
 */
export type NormalizedExecutionPlan = {
  kind: "normalized-execution-plan";
  schemaVersion: ContractExecutionPlan["schemaVersion"];
  workflowId: ContractExecutionPlan["workflowId"];
  workflowVersion: ContractExecutionPlan["workflowVersion"];
  nodes: NormalizedWorkflowNode[];
  edges: NormalizedWorkflowEdge[];
  topology: ContractExecutionTopology;
};

export type CompilationResult =
  | { ok: true; plan: NormalizedExecutionPlan; diagnostics: WorkflowDiagnostic[] }
  | { ok: false; plan?: undefined; diagnostics: WorkflowDiagnostic[] };

const JOIN_POLICIES = new Set(["all", "any", "quorum"]);
const ROUTE_NODE_POLICIES = new Set(["route", "router"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointerSegment(value: string | number): string {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(segments: Array<string | number>): string {
  return segments.length === 0 ? "" : `/${segments.map(pointerSegment).join("/")}`;
}

function diagnostic(
  code: DiagnosticCode,
  message: string,
  pathSegments: Array<string | number>,
  extras: Pick<WorkflowDiagnostic, "nodeId" | "edgeId"> = {},
): WorkflowDiagnostic {
  return {
    code,
    severity: "error",
    message,
    path: pointer(pathSegments),
    pathSegments,
    ...extras,
  };
}

function configOf(node: RawRecord): RawRecord | undefined {
  return isRecord(node.config) ? node.config : undefined;
}

function field(node: RawRecord, name: string): unknown {
  if (node[name] !== undefined) return node[name];
  return configOf(node)?.[name];
}

function kindOf(node: RawRecord): string | undefined {
  const value = node.kind ?? node.type;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function edgeRoute(edge: RawRecord): string | undefined {
  // `label` is the canonical contract field; `route` remains accepted for
  // the validator's deliberately loose input boundary and older fixtures.
  // Conditions are independent predicates and must never become route labels.
  return stringField(edge.label) ?? stringField(edge.route);
}

function hasOwn(node: RawRecord, name: string): boolean {
  return node[name] !== undefined || configOf(node)?.[name] !== undefined;
}

function requiredField(
  node: RawRecord,
  nodeIndex: number,
  name: string,
  diagnostics: WorkflowDiagnostic[],
  predicate: (value: unknown) => boolean = (value) => value !== undefined && value !== null,
): void {
  const value = field(node, name);
  if (!predicate(value)) {
    diagnostics.push(
      diagnostic(
        "NODE_REQUIRED_FIELD",
        `Node kind requires a non-empty ${name} field.`,
        [
          "nodes",
          nodeIndex,
          node[name] !== undefined || node.config === undefined ? name : "config",
          ...(node[name] !== undefined || node.config === undefined ? [] : [name]),
        ],
        { nodeId: stringField(node.id) },
      ),
    );
  }
}

function validateKindFields(
  node: RawRecord,
  index: number,
  diagnostics: WorkflowDiagnostic[],
): void {
  const kind = kindOf(node);
  if (!kind) return;
  const nonEmptyString = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const nonEmptyArray = (value: unknown) => Array.isArray(value) && value.length > 0;
  switch (kind) {
    case "agent":
      requiredField(node, index, "prompt", diagnostics, nonEmptyString);
      break;
    case "verify":
      if (!hasOwn(node, "commands") && !hasOwn(node, "command")) {
        requiredField(node, index, "commands", diagnostics, nonEmptyArray);
      } else if (hasOwn(node, "commands") && !nonEmptyArray(field(node, "commands"))) {
        diagnostics.push(
          diagnostic(
            "NODE_FIELD_INVALID",
            "Verify commands must be a non-empty array.",
            ["nodes", index, "commands"],
            { nodeId: stringField(node.id) },
          ),
        );
      }
      break;
    case "approval":
      if (!hasOwn(node, "message") && !hasOwn(node, "prompt")) {
        requiredField(node, index, "message", diagnostics, nonEmptyString);
      } else if (!nonEmptyString(field(node, "message") ?? field(node, "prompt"))) {
        diagnostics.push(
          diagnostic(
            "NODE_FIELD_INVALID",
            "Approval message must be a non-empty string.",
            ["nodes", index, "message"],
            { nodeId: stringField(node.id) },
          ),
        );
      }
      break;
    case "join":
      if (!hasOwn(node, "policy") && !hasOwn(node, "joinPolicy")) {
        requiredField(node, index, "policy", diagnostics, nonEmptyString);
      }
      break;
    case "transform":
      requiredField(node, index, "mapping", diagnostics, isRecord);
      break;
    case "route":
      // A route node's outgoing labels are validated against its edges below.
      break;
    default:
      diagnostics.push(
        diagnostic(
          "UNSUPPORTED_NODE_KIND",
          `Unsupported node kind '${kind}'.`,
          ["nodes", index, "kind"],
          { nodeId: stringField(node.id) },
        ),
      );
  }
}

function validateJoin(
  node: RawRecord,
  index: number,
  incoming: NormalizedWorkflowEdge[],
  diagnostics: WorkflowDiagnostic[],
): void {
  const predecessorIds = new Set(incoming.map((edge) => edge.source));
  const predecessorCount = predecessorIds.size;
  if (predecessorCount < 2) {
    diagnostics.push(
      diagnostic(
        "JOIN_INCOMING_REQUIRED",
        "A join node must have at least two incoming edges.",
        ["nodes", index],
        { nodeId: stringField(node.id) },
      ),
    );
  }
  const policy = field(node, "policy") ?? field(node, "joinPolicy");
  if (policy === undefined || policy === null || policy === "") {
    diagnostics.push(
      diagnostic(
        "JOIN_POLICY_REQUIRED",
        "A join node must declare a join policy.",
        ["nodes", index, "policy"],
        { nodeId: stringField(node.id) },
      ),
    );
    return;
  }
  if (typeof policy !== "string" || !JOIN_POLICIES.has(policy)) {
    diagnostics.push(
      diagnostic(
        "JOIN_POLICY_INVALID",
        "Join policy must be one of: all, any, quorum.",
        ["nodes", index, node.policy !== undefined ? "policy" : "config"],
        { nodeId: stringField(node.id) },
      ),
    );
    return;
  }
  if (policy === "quorum") {
    const quorum = field(node, "quorum");
    if (
      !Number.isInteger(quorum) ||
      (quorum as number) < 1 ||
      (quorum as number) > predecessorCount
    ) {
      diagnostics.push(
        diagnostic(
          "JOIN_POLICY_SHAPE_INVALID",
          "A quorum join requires an integer quorum between 1 and its distinct predecessor-node count.",
          ["nodes", index, "quorum"],
          { nodeId: stringField(node.id) },
        ),
      );
    }
  }
}

function validateRoutes(
  node: NormalizedWorkflowNode,
  outgoing: NormalizedWorkflowEdge[],
  diagnostics: WorkflowDiagnostic[],
): void {
  const routeNode = ROUTE_NODE_POLICIES.has(node.kind);
  const seen = new Map<string, NormalizedWorkflowEdge>();
  for (const edge of outgoing) {
    if (routeNode && !edge.route) {
      diagnostics.push(
        diagnostic(
          "ROUTE_LABEL_REQUIRED",
          "Every outgoing edge from a route node needs a non-empty route label.",
          ["edges", edge.index, "route"],
          { nodeId: node.id, edgeId: edge.id },
        ),
      );
    }
    if (!routeNode && edge.route) {
      diagnostics.push(
        diagnostic(
          "ROUTE_LABEL_UNEXPECTED",
          "Only route nodes may label outgoing edges with a route.",
          ["edges", edge.index, "route"],
          { nodeId: node.id, edgeId: edge.id },
        ),
      );
    }
    if (edge.route) {
      const previous = seen.get(edge.route);
      if (previous) {
        diagnostics.push(
          diagnostic(
            "ROUTE_LABEL_DUPLICATE",
            `Route label '${edge.route}' is used more than once for this route node.`,
            ["edges", edge.index, "route"],
            { nodeId: node.id, edgeId: edge.id },
          ),
        );
      } else {
        seen.set(edge.route, edge);
      }
    }
  }
  if (routeNode && outgoing.length === 0) {
    diagnostics.push(
      diagnostic(
        "ROUTE_OUTGOING_INCONSISTENT",
        "A route node must have at least one outgoing edge.",
        ["nodes", node.index, "edges"],
        { nodeId: node.id },
      ),
    );
  }
  const declared = field(node.value, "routes");
  if (Array.isArray(declared)) {
    const declaredLabels = new Set(
      declared.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    );
    for (const edge of outgoing) {
      if (edge.route && !declaredLabels.has(edge.route)) {
        diagnostics.push(
          diagnostic(
            "ROUTE_OUTGOING_INCONSISTENT",
            `Route label '${edge.route}' is not declared by the route node.`,
            ["edges", edge.index, "route"],
            { nodeId: node.id, edgeId: edge.id },
          ),
        );
      }
    }
    for (const label of declaredLabels) {
      if (!outgoing.some((edge) => edge.route === label)) {
        diagnostics.push(
          diagnostic(
            "ROUTE_OUTGOING_INCONSISTENT",
            `Declared route label '${label}' has no outgoing edge.`,
            ["nodes", node.index, "routes"],
            { nodeId: node.id },
          ),
        );
      }
    }
  }
  const defaultRoute = stringField(field(node.value, "defaultRoute"));
  if (defaultRoute && !outgoing.some((edge) => edge.route === defaultRoute)) {
    diagnostics.push(
      diagnostic(
        "ROUTE_OUTGOING_INCONSISTENT",
        `Default route '${defaultRoute}' has no matching outgoing route label.`,
        ["nodes", node.index, "defaultRoute"],
        { nodeId: node.id },
      ),
    );
  }
}

type ValueReferenceLocation = {
  reference: RawRecord;
  pathSegments: Array<string | number>;
  owner: Pick<WorkflowDiagnostic, "nodeId" | "edgeId">;
};

function valueReferenceLocations(node: NormalizedWorkflowNode): ValueReferenceLocation[] {
  const locations: ValueReferenceLocation[] = [];
  const addRecord = (name: "inputBindings" | "mapping"): void => {
    const value = field(node.value, name);
    if (!isRecord(value)) return;
    for (const [key, reference] of Object.entries(value)) {
      if (isRecord(reference)) {
        locations.push({
          reference,
          pathSegments: ["nodes", node.index, name, key],
          owner: { nodeId: node.id },
        });
      }
    }
  };

  addRecord("inputBindings");
  addRecord("mapping");
  return locations;
}

function predicateReferenceLocations(
  value: unknown,
  pathSegments: Array<string | number>,
  owner: Pick<WorkflowDiagnostic, "nodeId" | "edgeId">,
  locations: ValueReferenceLocation[],
): void {
  if (!isRecord(value)) return;
  if (value.kind === "reference" && isRecord(value.reference)) {
    locations.push({
      reference: value.reference,
      pathSegments: [...pathSegments, "reference"],
      owner,
    });
    return;
  }
  if (value.kind === "comparison") {
    predicateReferenceLocations(value.left, [...pathSegments, "left"], owner, locations);
    predicateReferenceLocations(value.right, [...pathSegments, "right"], owner, locations);
    return;
  }
  if (value.kind === "boolean" && Array.isArray(value.operands)) {
    value.operands.forEach((operand, index) => {
      predicateReferenceLocations(operand, [...pathSegments, "operands", index], owner, locations);
    });
    return;
  }
  if (value.kind === "not") {
    predicateReferenceLocations(value.operand, [...pathSegments, "operand"], owner, locations);
  }
}

function validateValueReferences(
  workflow: RawRecord,
  nodes: NormalizedWorkflowNode[],
  edges: NormalizedWorkflowEdge[],
  outgoing: Map<string, NormalizedWorkflowEdge[]>,
  diagnostics: WorkflowDiagnostic[],
): void {
  const inputNames = new Set<string>();
  if (Array.isArray(workflow.inputs)) {
    for (const input of workflow.inputs) {
      if (isRecord(input)) {
        const name = stringField(input.name);
        if (name) inputNames.add(name);
      }
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const hasPath = (source: string, target: string): boolean => {
    const visited = new Set<string>();
    const pending = [source];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      if (id === target) return true;
      for (const edge of outgoing.get(id) ?? []) pending.push(edge.target);
    }
    return false;
  };

  for (const node of nodes) {
    for (const { reference, pathSegments, owner } of valueReferenceLocations(node)) {
      if (reference.kind === "workflow_input") {
        const name = stringField(reference.name);
        if (name && !inputNames.has(name)) {
          diagnostics.push(
            diagnostic(
              "WORKFLOW_INPUT_REFERENCE_INVALID",
              `Workflow input reference '${name}' does not identify a declared workflow input.`,
              [...pathSegments, "name"],
              owner,
            ),
          );
        }
        continue;
      }
      if (reference.kind !== "node_output") continue;

      const targetId = stringField(reference.nodeId);
      if (!targetId || !nodeById.has(targetId)) {
        diagnostics.push(
          diagnostic(
            "NODE_OUTPUT_REFERENCE_TARGET_MISSING",
            `Node output reference '${targetId ?? ""}' does not identify an existing node.`,
            [...pathSegments, "nodeId"],
            owner,
          ),
        );
        continue;
      }
      if (targetId === node.id) {
        diagnostics.push(
          diagnostic(
            "NODE_OUTPUT_REFERENCE_SELF",
            "A node output reference may not target the node that contains the reference.",
            [...pathSegments, "nodeId"],
            owner,
          ),
        );
        continue;
      }
      if (!hasPath(targetId, node.id)) {
        diagnostics.push(
          diagnostic(
            "NODE_OUTPUT_REFERENCE_NOT_UPSTREAM",
            `Node output reference '${targetId}' must target a strict upstream dependency.`,
            [...pathSegments, "nodeId"],
            owner,
          ),
        );
      }
    }
  }

  for (const edge of edges) {
    const locations: ValueReferenceLocation[] = [];
    predicateReferenceLocations(
      edge.value.condition,
      ["edges", edge.index, "condition"],
      { edgeId: edge.id },
      locations,
    );
    for (const { reference, pathSegments, owner } of locations) {
      if (reference.kind === "workflow_input") {
        const name = stringField(reference.name);
        if (name && !inputNames.has(name)) {
          diagnostics.push(
            diagnostic(
              "WORKFLOW_INPUT_REFERENCE_INVALID",
              `Workflow input reference '${name}' does not identify a declared workflow input.`,
              [...pathSegments, "name"],
              owner,
            ),
          );
        }
        continue;
      }
      if (reference.kind !== "node_output") continue;

      const targetId = stringField(reference.nodeId);
      if (!targetId || !nodeById.has(targetId)) {
        diagnostics.push(
          diagnostic(
            "NODE_OUTPUT_REFERENCE_TARGET_MISSING",
            `Node output reference '${targetId ?? ""}' does not identify an existing node.`,
            [...pathSegments, "nodeId"],
            owner,
          ),
        );
        continue;
      }
      if (targetId === edge.source || !hasPath(targetId, edge.source)) {
        diagnostics.push(
          diagnostic(
            "NODE_OUTPUT_REFERENCE_NOT_UPSTREAM",
            `Node output reference '${targetId}' must target a strict upstream dependency.`,
            [...pathSegments, "nodeId"],
            owner,
          ),
        );
      }
    }
  }
}

export function validateWorkflow(workflow: unknown): WorkflowValidationResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  const emptyGraph: NormalizedWorkflowGraph = {
    nodes: [],
    edges: [],
    startNodeIds: [],
    terminalNodeIds: [],
    reachableNodeIds: [],
    topologicalOrder: [],
  };
  if (!isRecord(workflow)) {
    diagnostics.push(
      diagnostic("WORKFLOW_NOT_OBJECT", "Workflow definition must be an object.", []),
    );
    return { valid: false, diagnostics, graph: emptyGraph };
  }

  const rawNodes = workflow.nodes;
  const rawEdges = workflow.edges;
  if (!Array.isArray(rawNodes))
    diagnostics.push(diagnostic("NODES_NOT_ARRAY", "Workflow nodes must be an array.", ["nodes"]));
  if (!Array.isArray(rawEdges))
    diagnostics.push(diagnostic("EDGES_NOT_ARRAY", "Workflow edges must be an array.", ["edges"]));
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges))
    return { valid: false, diagnostics, graph: emptyGraph };

  const nodes: NormalizedWorkflowNode[] = [];
  const nodeById = new Map<string, NormalizedWorkflowNode>();
  const nodeIdPaths = new Map<string, number>();
  rawNodes.forEach((raw, index) => {
    if (!isRecord(raw)) {
      diagnostics.push(
        diagnostic("NODE_ID_INVALID", "Node must be an object with a non-empty id.", [
          "nodes",
          index,
        ]),
      );
      return;
    }
    const id = stringField(raw.id);
    if (!id) {
      diagnostics.push(
        diagnostic("NODE_ID_INVALID", "Node id must be a non-empty string.", [
          "nodes",
          index,
          "id",
        ]),
      );
      return;
    }
    if (nodeIdPaths.has(id)) {
      diagnostics.push(
        diagnostic("DUPLICATE_NODE_ID", `Node id '${id}' is duplicated.`, ["nodes", index, "id"], {
          nodeId: id,
        }),
      );
      return;
    }
    const kind = kindOf(raw);
    if (!kind)
      diagnostics.push(
        diagnostic(
          "NODE_KIND_INVALID",
          "Node kind must be a non-empty string.",
          ["nodes", index, "kind"],
          { nodeId: id },
        ),
      );
    const node: NormalizedWorkflowNode = { id, kind: kind ?? "", index, value: raw };
    nodes.push(node);
    nodeById.set(id, node);
    nodeIdPaths.set(id, index);
    validateKindFields(raw, index, diagnostics);
  });

  const edges: NormalizedWorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  rawEdges.forEach((raw, index) => {
    if (!isRecord(raw)) {
      diagnostics.push(
        diagnostic("EDGE_ID_INVALID", "Edge must be an object with an id, source, and target.", [
          "edges",
          index,
        ]),
      );
      return;
    }
    const id = stringField(raw.id);
    if (!id)
      diagnostics.push(
        diagnostic("EDGE_ID_INVALID", "Edge id must be a non-empty string.", [
          "edges",
          index,
          "id",
        ]),
      );
    else if (edgeIds.has(id))
      diagnostics.push(
        diagnostic("DUPLICATE_EDGE_ID", `Edge id '${id}' is duplicated.`, ["edges", index, "id"], {
          edgeId: id,
        }),
      );
    else edgeIds.add(id);
    const source = stringField(raw.source);
    const target = stringField(raw.target);
    if (!source)
      diagnostics.push(
        diagnostic(
          "EDGE_SOURCE_INVALID",
          "Edge source must be a non-empty string.",
          ["edges", index, "source"],
          { edgeId: id },
        ),
      );
    if (!target)
      diagnostics.push(
        diagnostic(
          "EDGE_TARGET_INVALID",
          "Edge target must be a non-empty string.",
          ["edges", index, "target"],
          { edgeId: id },
        ),
      );
    if (!id || !source || !target) return;
    if (!nodeById.has(source))
      diagnostics.push(
        diagnostic(
          "EDGE_ENDPOINT_MISSING",
          `Edge source '${source}' does not identify a node.`,
          ["edges", index, "source"],
          { edgeId: id },
        ),
      );
    if (!nodeById.has(target))
      diagnostics.push(
        diagnostic(
          "EDGE_ENDPOINT_MISSING",
          `Edge target '${target}' does not identify a node.`,
          ["edges", index, "target"],
          { edgeId: id },
        ),
      );
    const route = edgeRoute(raw);
    edges.push({ id, source, target, index, route, condition: raw.condition, value: raw });
  });

  const incoming = new Map<string, NormalizedWorkflowEdge[]>();
  const outgoing = new Map<string, NormalizedWorkflowEdge[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (nodeById.has(edge.source) && nodeById.has(edge.target)) {
      outgoing.get(edge.source)?.push(edge);
      incoming.get(edge.target)?.push(edge);
    }
  }

  for (const node of nodes) {
    const inEdges = incoming.get(node.id) ?? [];
    const outEdges = outgoing.get(node.id) ?? [];
    validateRoutes(node, outEdges, diagnostics);
    if (node.kind === "join") validateJoin(node.value, node.index, inEdges, diagnostics);
  }

  const explicitStart = stringField(workflow.startNodeId) ?? stringField(workflow.entryNodeId);
  const roots = nodes
    .filter((node) => (incoming.get(node.id)?.length ?? 0) === 0)
    .map((node) => node.id);
  // A graph without an explicit entry has one implicit entry: the first root.
  // Additional roots are retained as an error and treated as disconnected so
  // callers get useful per-node paths instead of an apparently reachable
  // forest.
  let startNodeIds = explicitStart ? [explicitStart] : roots.slice(0, 1);
  if (explicitStart && !nodeById.has(explicitStart)) {
    diagnostics.push(
      diagnostic("START_NODE_INVALID", `Start node '${explicitStart}' does not identify a node.`, [
        workflow.startNodeId !== undefined ? "startNodeId" : "entryNodeId",
      ]),
    );
    startNodeIds = [];
  }
  if (!explicitStart && roots.length === 0 && nodes.length > 0)
    diagnostics.push(
      diagnostic(
        "START_NODE_MISSING",
        "The workflow has no start node; every node has an incoming edge.",
        ["nodes"],
      ),
    );
  if (!explicitStart && roots.length > 1)
    diagnostics.push(
      diagnostic(
        "MULTIPLE_START_NODES",
        "The workflow has multiple start nodes; provide an explicit startNodeId for a single entry point.",
        ["nodes"],
      ),
    );

  const reachable = new Set<string>();
  const stack = [...startNodeIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    if (reachable.has(id) || !nodeById.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) stack.push(edge.target);
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      diagnostics.push(
        diagnostic(
          "NODE_UNREACHABLE",
          `Node '${node.id}' is not reachable from a workflow start node.`,
          ["nodes", node.index],
          { nodeId: node.id },
        ),
      );
      diagnostics.push(
        diagnostic(
          "DISCONNECTED_SUBGRAPH",
          `Node '${node.id}' belongs to a disconnected subgraph.`,
          ["nodes", node.index],
          { nodeId: node.id },
        ),
      );
    }
  }

  const terminalNodeIds = nodes
    .filter((node) => reachable.has(node.id) && (outgoing.get(node.id)?.length ?? 0) === 0)
    .map((node) => node.id);
  if (nodes.length > 0 && terminalNodeIds.length === 0)
    diagnostics.push(
      diagnostic(
        "NO_REACHABLE_TERMINAL",
        "The workflow must have at least one reachable terminal node.",
        ["nodes"],
      ),
    );

  const color = new Map<string, 0 | 1 | 2>();
  const topo: string[] = [];
  const visit = (id: string): void => {
    if (!reachable.has(id)) return;
    const state = color.get(id) ?? 0;
    if (state === 1) return;
    if (state === 2) return;
    color.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) visit(edge.target);
    color.set(id, 2);
    topo.push(id);
  };
  for (const id of startNodeIds) visit(id);
  // Cycles with no root are still invalid, even though no execution path can
  // reach them. Walk the remaining graph solely to surface the cycle code,
  // without putting disconnected nodes into the execution order.
  const cycleColor = new Map<string, 0 | 1 | 2>();
  const detectCycle = (id: string): void => {
    const state = cycleColor.get(id) ?? 0;
    if (state === 1) {
      diagnostics.push(
        diagnostic(
          "CYCLE_UNSUPPORTED",
          `Cycle detected at node '${id}'; MVP workflows must be acyclic.`,
          ["nodes", nodeById.get(id)?.index ?? -1],
          { nodeId: id },
        ),
      );
      return;
    }
    if (state === 2) return;
    cycleColor.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) detectCycle(edge.target);
    cycleColor.set(id, 2);
  };
  for (const node of nodes) detectCycle(node.id);
  topo.reverse();

  const graph: NormalizedWorkflowGraph = {
    nodes,
    edges,
    startNodeIds,
    terminalNodeIds,
    reachableNodeIds: nodes.filter((node) => reachable.has(node.id)).map((node) => node.id),
    topologicalOrder: topo,
  };
  validateValueReferences(workflow, nodes, edges, outgoing, diagnostics);
  return { valid: diagnostics.every((item) => item.severity !== "error"), diagnostics, graph };
}

/**
 * Minimal compiler seam. This normalizes graph data only; scheduling,
 * provider binding, policy compilation, and execution intentionally belong to
 * later runtime phases.
 */
export function prepareExecutionPlan(workflow: WorkflowDefinition): CompilationResult;
/** The validator also intentionally accepts unparsed input for diagnostics. */
export function prepareExecutionPlan(workflow: unknown): CompilationResult;
export function prepareExecutionPlan(workflow: unknown): CompilationResult {
  const contractResult = WorkflowDefinitionSchema.safeParse(workflow);
  const contractDiagnostics: WorkflowDiagnostic[] = contractResult.success
    ? []
    : contractResult.error.issues.map((issue) => {
        const pathSegments = issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        );
        return diagnostic("WORKFLOW_CONTRACT_INVALID", issue.message, pathSegments);
      });
  const result = validateWorkflow(contractResult.success ? contractResult.data : workflow);
  const diagnostics = [...contractDiagnostics, ...result.diagnostics];
  if (!contractResult.success || !result.valid) return { ok: false, diagnostics };
  const definition = contractResult.data;
  return {
    ok: true,
    diagnostics,
    plan: {
      kind: "normalized-execution-plan",
      schemaVersion: definition.schemaVersion,
      workflowId: definition.id,
      workflowVersion: definition.workflowVersion,
      nodes: result.graph.nodes,
      edges: result.graph.edges,
      topology: {
        startNodeIds: result.graph.startNodeIds,
        terminalNodeIds: result.graph.terminalNodeIds,
        topologicalOrder: result.graph.topologicalOrder,
      },
    },
  };
}

export const validateWorkflowDefinition = validateWorkflow;
export const compileWorkflow = prepareExecutionPlan;
