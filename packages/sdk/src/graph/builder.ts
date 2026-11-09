import {
  type Edge,
  type Graph,
  type GraphMeta,
  type GraphRetry,
  graphTypeResolver,
  type InputValidation,
  type Node,
  type NodeId,
  nodeNames,
  type OutSchema,
  type RecordSpec,
  type RefId,
} from "@loopy/core";
import { type AuthorValue, REF, type Ref, Reference, type RefValue, serialize } from "./ref";
import { refuse, validateLabel } from "./validate";

type Tail = { id: NodeId; kind: "next" | "join" };

type Frame = {
  scope: NodeId | null;
  token: symbol;
  labels: Set<string>;
  first: NodeId | null;
  tails: Tail[];
};

type NodeData = Node extends infer N
  ? N extends Node
    ? Omit<N, "id" | "scope" | "label">
    : never
  : never;

type ControlKind = "branch" | "switch" | "map" | "parallel" | "finally" | "rescue";

type ControlArm = { name: string; run: () => AuthorValue };

type Control = {
  arms: readonly ControlArm[];
  node: (entry: (arm: string) => NodeId) => Extract<NodeData, { kind: ControlKind }>;
};

function isNodeId(value: string): value is NodeId {
  return value.length > 0;
}

function isRefId(value: string): value is RefId {
  return value.length > 0;
}

function id(value: string): NodeId {
  if (isNodeId(value)) {
    return value;
  }

  return refuse("unresolved_ref", "Identifiers must be nonempty.");
}

function bindingId(value: string): RefId {
  if (isRefId(value)) {
    return value;
  }

  return refuse("unresolved_ref", "Identifiers must be nonempty.");
}

function frame(scope: NodeId | null): Frame {
  return { scope, token: Symbol(), labels: new Set(), first: null, tails: [] };
}

type Activation = { builder: GraphBuilder | null };

const activation: Activation = { builder: null };

export function currentBuilder(): GraphBuilder {
  return (
    activation.builder ?? refuse("inactive_builder", "Create nodes inside a synchronous loopy run.")
  );
}

export function retryPolicy(retry?: Partial<GraphRetry>): GraphRetry {
  return { attempts: 3, retryOnExit: false, ...retry };
}

export class GraphBuilder {
  readonly nodes: Node[] = [];
  readonly edges: Edge[] = [];
  readonly frames: Frame[] = [frame(null)];
  readonly prefixes: string[] = [];
  private readonly order = new Map<NodeId, number>();

  constructor(
    readonly name: string,
    readonly input: RecordSpec,
    readonly meta: GraphMeta,
    readonly inputValidation: InputValidation | undefined,
  ) {
    Object.keys(input).forEach(validateLabel);
  }

  get scope(): Frame {
    const value = this.frames.at(-1);

    if (!value) {
      return refuse("invalid_scope", "The builder requires an active scope.");
    }

    return value;
  }

  run<T>(callback: () => T): T {
    if (activation.builder) {
      refuse("inactive_builder", "Finish the active builder before starting another loopy.");
    }

    activation.builder = this;

    try {
      return callback();
    } finally {
      activation.builder = null;
    }
  }

  expand<T>(label: string, callback: () => T): T {
    const scope = this.scope;
    const labels = scope.labels;
    scope.labels = new Set();
    this.prefixes.push(label);

    try {
      return callback();
    } finally {
      this.prefixes.pop();
      scope.labels = labels;
    }
  }

  allocate(label: string | null, fallback: string) {
    if (label !== null) {
      validateLabel(label);
    }

    validateLabel(fallback);
    const name = [...this.prefixes, label ?? fallback].join("/");

    if (label !== null && this.scope.labels.has(name)) {
      refuse("duplicate_label", "Labels must be unique inside one scope.");
    }

    if (label !== null) {
      this.scope.labels.add(name);
    }

    const nodeId = id(`${this.order.size}:${name}`);
    this.order.set(nodeId, this.order.size);

    return { id: nodeId, label, scope: this.scope.scope };
  }

  add(data: NodeData, label: string | null = null) {
    const base = this.allocate(label, data.kind === "command" ? data.key : data.kind);
    const node = { ...base, ...data };
    this.record(node);

    return base;
  }

  record(node: Node) {
    nodeNames(node).forEach(validateLabel);
    this.nodes.push(node);
    this.scope.first ??= node.id;

    for (const tail of this.scope.tails) {
      this.edge(tail.id, node.id, tail.kind);
    }

    this.scope.tails = node.kind === "fail" ? [] : [{ id: node.id, kind: "next" }];
  }

  binding(owner: NodeId, name: string) {
    return bindingId(`${owner}:${name}`);
  }

  ref<T, Fields = never>(refId: string, schema?: OutSchema | null): Ref<T, Fields>;
  ref(refId: string, schema: OutSchema | null = null): RefValue {
    const referenceId = bindingId(refId);

    return new Reference({ owner: this, scope: this.scope.token, id: referenceId, schema });
  }

  check(ref: RefValue) {
    const metadata = ref[REF];

    if (metadata.owner !== this || !this.frames.some((scope) => scope.token === metadata.scope)) {
      refuse("out_of_scope_ref", "Reference is unavailable in this scope.");
    }
  }

  edge(from: NodeId, to: NodeId, kind: Edge["kind"]) {
    this.edges.push({ from, to, kind });
  }

  /** Records a control node, expands its arms in order, then points the node at their entries. */
  control(kind: ControlKind, build: (id: NodeId) => Control) {
    const base = this.allocate(null, kind);
    const { arms, node } = build(base.id);
    const index = this.nodes.length;
    // Type resolution inside the arms needs the control's bindings before its arm entries exist.
    this.record({ ...base, ...node(() => base.id) });
    const entries = new Map<string, NodeId>();
    const tails: NodeId[] = [];

    for (const arm of arms) {
      const expanded = this.arm(base.id, arm.run);
      entries.set(arm.name, expanded.entry);
      tails.push(...expanded.tails);
    }

    this.nodes[index] = { ...base, ...node((arm) => entries.get(arm) ?? base.id) };

    return { id: base.id, tails };
  }

  arm(owner: NodeId, callback: () => AuthorValue) {
    const child = frame(owner);
    this.frames.push(child);

    try {
      const result = callback();

      if (child.first === null || child.tails.length > 0) {
        const nonReturning =
          child.tails.length > 0 &&
          child.tails.every((tail) =>
            this.nodes.some(
              (node) => node.id === tail.id && node.kind === "join" && node.result.kind === "none",
            ),
          );

        this.add({
          kind: "join",
          result: nonReturning
            ? { kind: "none" }
            : { kind: "value", value: serialize(result, this) },
        });
      }

      return { entry: child.first ?? owner, tails: child.tails.map((tail) => tail.id) };
    } finally {
      this.frames.pop();
    }
  }

  continueFrom(owner: NodeId, tails: NodeId[], kind: Tail["kind"] = "join") {
    this.scope.tails =
      tails.length === 0
        ? [{ id: owner, kind: "next" }]
        : tails.map((nodeId) => ({ id: nodeId, kind }));

    const value = { ref: bindingId(owner), path: [] };

    const type = graphTypeResolver({ input: this.input, nodes: this.nodes, edges: this.edges })(
      value,
    );

    return this.add({
      kind: "join",
      result: type === "never" ? { kind: "none" } : { kind: "value", value },
    });
  }

  finish(result: AuthorValue): Graph {
    const terminal = this.scope.first !== null && this.scope.tails.length === 0;

    const output = terminal
      ? null
      : this.add({ kind: "join", result: { kind: "value", value: serialize(result, this) } });

    const entry =
      this.scope.first ?? refuse("missing_entry", "The builder requires an entry node.");

    return {
      meta: this.meta,
      version: 1,
      name: this.name,
      input: this.input,
      inputValidation: this.inputValidation,
      nodes: this.nodes,
      edges: this.edges.sort(
        (a, b) => (this.order.get(a.from) ?? 0) - (this.order.get(b.from) ?? 0),
      ),
      entry,
      outputs: output === null ? null : { ref: bindingId(output.id), path: [] },
      warnings: [],
    };
  }
}
