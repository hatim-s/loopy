import {
  type Edge,
  type Graph,
  type GraphRetry,
  type InputSpec,
  type Node,
  type NodeId,
  type NodeKind,
  type OutputSchema,
  type Predicate,
  type RefId,
} from "../../core/index.js";
import { type AuthorValue, checkSerialized, REF, Ref, type RefValue, serialize } from "./ref.js";
import { refuse, validate, validateArguments } from "./validate.js";

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

export class GraphBuilder {
  readonly nodes: Node[] = [];
  readonly edges: Edge[] = [];
  readonly frames: Frame[] = [frame(null)];
  readonly prefixes: string[] = [];
  private readonly order = new Map<NodeId, number>();

  constructor(
    readonly name: string,
    readonly input: InputSpec,
  ) {}

  get scope(): Frame {
    const value = this.frames.at(-1);

    if (!value) {
      return refuse("invalid_scope", "The builder requires an active scope.");
    }

    return value;
  }

  // BOUNDARY: Synchronous author evaluation owns the module-level activation until it returns.
  run<T>(callback: () => T): T {
    if (activation.builder) {
      refuse("inactive_builder", "Finish the active builder before starting another loopy.");
    }

    // Construction is synchronous; one active builder also catches accidental nested builds.
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

  // PR 3 checks label literals in the AST; construction accepts the already typed string.
  allocate(kind: NodeKind, label: string | null) {
    const name = [...this.prefixes, label ?? kind].join("/");

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
    const base = this.allocate(data.kind, label);
    const node = { ...base, ...data };
    this.record(node);

    return base;
  }

  record(node: Node) {
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

  caseEdge(from: NodeId, to: NodeId, label: string) {
    this.edges.push({ from, to, kind: "case", label });
  }

  ref<T>(refId: string, schema: OutputSchema | null = null): Ref<T> {
    const referenceId = bindingId(refId);

    return new Ref({ owner: this, scope: this.scope.token, id: referenceId, schema });
  }

  check(ref: RefValue) {
    const metadata = ref[REF];

    if (metadata.owner !== this || !this.frames.some((scope) => scope.token === metadata.scope)) {
      refuse("out_of_scope_ref", "Reference is unavailable in this scope.");
    }
  }

  retry(retry?: Partial<GraphRetry>): GraphRetry {
    return { attempts: 3, backoff: "exponential", retryOnExit: false, ...retry };
  }

  edge(from: NodeId, to: NodeId, kind: Exclude<Edge["kind"], "case">) {
    this.edges.push({ from, to, kind });
  }

  arm(owner: NodeId, callback: () => AuthorValue) {
    const child = frame(owner);
    this.frames.push(child);

    try {
      const result = callback();

      if (child.first === null || child.tails.length > 0) {
        this.add({ kind: "join", result: serialize(result, this) });
      }

      return { entry: child.first ?? owner, tails: child.tails.map((tail) => tail.id) };
    } finally {
      this.frames.pop();
    }
  }

  continueFrom(tails: NodeId[]) {
    this.scope.tails = tails.map((nodeId) => ({ id: nodeId, kind: "join" }));
  }

  predicate(predicate: Predicate): Predicate {
    if (predicate.op === "and" || predicate.op === "or") {
      predicate.predicates.forEach((child) => this.predicate(child));
    } else if (predicate.op === "not") {
      this.predicate(predicate.predicate);
    } else if (predicate.op === "exists" || predicate.op === "isNull") {
      checkSerialized(predicate.value, this);
    } else if ("left" in predicate) {
      checkSerialized(predicate.left, this);
      checkSerialized(predicate.right, this);
    }

    const base = { id: id("predicate-check"), label: null, scope: this.scope.scope };
    const node: Node = { ...base, kind: "branch", predicate, arms: { yes: base.id, no: base.id } };
    validateArguments({ ...this.snapshot(base.id), nodes: [...this.nodes, node] });

    return predicate;
  }

  snapshot(entry: NodeId): Graph {
    return {
      version: 1,
      name: this.name,
      input: this.input,
      nodes: this.nodes,
      edges: this.edges,
      entry,
      outputs: null,
      warnings: [],
    };
  }

  finish(result: AuthorValue) {
    const terminal = this.scope.first !== null && this.scope.tails.length === 0;
    const output = this.add({ kind: "join", result: terminal ? null : serialize(result, this) });
    const graph = this.snapshot(this.scope.first ?? output.id);
    graph.outputs = { ref: bindingId(output.id), path: [] };
    graph.edges.sort((a, b) => (this.order.get(a.from) ?? 0) - (this.order.get(b.from) ?? 0));

    return { graph, diagnostics: validate(graph) };
  }
}
