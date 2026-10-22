import type { GraphView } from "loopy/contract";
import { predicateText, refText, valueText } from "./graph-text.ts";
import type { SourceRange } from "./view-models.ts";

type GraphNode = GraphView["nodes"][number];

/** A code listing printed from the compiled graph, with each node's lines. */
export type Outline = { content: string; ranges: SourceRange[] };

export const OUTLINE_FILE = "outline";

const INDENT = "  ";

function name(node: GraphNode): string {
  return node.label ?? node.id.replace(/^\d+:/, "").replace(/\W+/g, "_");
}

function record(values: Record<string, Parameters<typeof valueText>[0]>): string {
  const entries = Object.entries(values);

  return entries.length === 0
    ? ""
    : `{ ${entries.map(([key, value]) => `${key}: ${valueText(value)}`).join(", ")} }`;
}

/** The one line that stands for a node, in the builder's own vocabulary. */
function line(node: GraphNode): string {
  switch (node.kind) {
    case "code": {
      return `const ${name(node)} = code("${node.module.name}", ${record(node.in) || "{}"})`;
    }

    case "command": {
      const argv = node.argv.map(valueText).join(", ");

      return node.key === "sh.exec"
        ? `const ${name(node)} = sh.exec([${argv}])`
        : `const ${name(node)} = ${node.key}(${record(node.flags)})`;
    }

    case "branch": {
      return `branch(${predicateText(node.predicate)}, {`;
    }

    case "switch": {
      return `switchOn(${refText(node.on)}, {`;
    }

    case "map": {
      return `map(${refText(node.over)}, { concurrency: ${node.concurrency}, onError: "${node.onError}" }, (item) => {`;
    }

    case "parallel": {
      return "parallel({";
    }

    case "finally": {
      return "withFinally({";
    }

    case "rescue": {
      return "rescue({";
    }

    case "wait": {
      return `const ${name(node)} = wait(${node.timeout === null ? "" : `{ timeout: "${node.timeout}" }`})`;
    }

    case "sleep": {
      return `sleep("${node.duration}")`;
    }

    case "fail": {
      return `fail(${valueText(node.message)})`;
    }

    case "format": {
      return `const ${name(node)} = format(${JSON.stringify(node.template)})`;
    }

    case "log": {
      return `log(${valueText(node.message)}${node.data === null ? "" : `, ${valueText(node.data)}`})`;
    }

    case "join": {
      return node.result.kind === "none" ? "return" : `return ${valueText(node.result.value)}`;
    }

    default: {
      return `const ${name(node)} = ${node.kind}()`;
    }
  }
}

/** The arms a control node opens, each a sequence that starts at a node id. */
function arms(node: GraphNode): [string, string][] {
  switch (node.kind) {
    case "branch": {
      return [
        ["yes", node.arms.yes],
        ["no", node.arms.no],
      ];
    }

    case "switch": {
      return [
        ...Object.entries(node.cases),
        ...(node.default === null ? [] : [["default", node.default] satisfies [string, string]]),
      ];
    }

    case "map": {
      return [["", node.body]];
    }

    case "parallel": {
      return Object.entries(node.branches);
    }

    case "finally": {
      return [
        ["body", node.body],
        ["cleanup", node.cleanup],
      ];
    }

    case "rescue": {
      return [
        ["body", node.body],
        ["handler", node.handler],
      ];
    }

    default: {
      return [];
    }
  }
}

/** Joins that only merge arms back together carry no code of their own. */
function merges(graph: GraphView, node: GraphNode): boolean {
  return (
    node.kind === "join" && graph.edges.some((edge) => edge.to === node.id && edge.kind === "join")
  );
}

/** Prints sequences of nodes depth first, recording each node's lines as it goes. */
class Printer {
  readonly lines: string[] = [];
  readonly ranges: SourceRange[] = [];
  private readonly printed = new Set<string>();
  private readonly byId: Map<string, GraphNode>;
  private readonly next = new Map<string, string>();

  constructor(private readonly graph: GraphView) {
    this.byId = new Map(graph.nodes.map((node) => [String(node.id), node]));

    for (const edge of graph.edges) {
      if (edge.kind === "next") {
        this.next.set(edge.from, edge.to);
      }
    }
  }

  sequence(start: string, depth: number) {
    let id: string | undefined = start;

    while (id !== undefined && !this.printed.has(id)) {
      const node = this.byId.get(id);

      if (!node) {
        return;
      }

      this.printed.add(id);

      if (!merges(this.graph, node)) {
        this.node(node, depth);
      }

      id = this.next.get(id);
    }
  }

  private node(node: GraphNode, depth: number) {
    const first = this.lines.length + 1;
    const pad = INDENT.repeat(depth);
    const opened = arms(node);
    this.lines.push(`${pad}${line(node)}`);

    for (const [label, target] of opened) {
      this.arm(label, target, depth);
    }

    if (opened.length > 0) {
      this.lines.push(`${pad}})`);
    }

    this.ranges.push({
      nodeId: node.id,
      fileId: OUTLINE_FILE,
      startLine: first,
      endLine: this.lines.length,
    });
  }

  // A labelled arm opens its own block; a map's single body sits directly inside the call.
  private arm(label: string, target: string, depth: number) {
    const pad = INDENT.repeat(depth + 1);

    if (label === "") {
      this.sequence(target, depth + 1);

      return;
    }

    this.lines.push(`${pad}${label}: () => {`);
    this.sequence(target, depth + 2);
    this.lines.push(`${pad}},`);
  }
}

function inputText(input: GraphView["input"]): string {
  return input === "schema"
    ? "schema"
    : `{ ${Object.entries(input)
        .map(([key, type]) => `${key}: ${type}`)
        .join(", ")} }`;
}

/**
 * Prints the compiled graph as a builder-style listing. It is not the author's source: names,
 * order and arguments come from the graph, so every range is exact for this listing. Joins that
 * only merge arms back together are left out; a scope's own return stays.
 */
export function printOutline(graph: GraphView): Outline {
  const printer = new Printer(graph);
  printer.lines.push(
    `loopy(${JSON.stringify(graph.name)}, { input: ${inputText(graph.input)} }, () => {`,
  );
  printer.sequence(graph.entry, 1);
  printer.lines.push("})");

  return { content: printer.lines.join("\n"), ranges: printer.ranges };
}
