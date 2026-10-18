import { resolve } from "node:path";
import { compile, formatDiagnostics } from "../../compiler/index.js";
import { type GraphView, graphView, routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { DaemonError } from "../errors.js";
import { printJson, printLine } from "../output.js";

function text(graph: GraphView) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));

  return graph.nodes
    .map((node) => {
      let depth = 0;

      for (let scope = node.scope; scope !== null; scope = nodes.get(scope)?.scope ?? null) {
        depth++;
      }

      const edges = graph.edges
        .filter((edge) => edge.from === node.id)
        .map((edge) => `${edge.kind}${edge.kind === "case" ? `:${edge.label}` : ""} -> ${edge.to}`)
        .join(", ");

      return `${"  ".repeat(depth)}${node.id} ${node.kind}${edges ? ` [${edges}]` : ""}`;
    })
    .join("\n");
}

export async function runGraph(context: CliContext): Promise<void> {
  const target = requireTarget(context, "Name or file");
  const format = context.values.format ?? "json";

  let graph: GraphView;

  if (/\.[cm]?[jt]sx?$/.test(target)) {
    const result = await compile(resolve(context.cwd, target), { home: context.home });

    if (!result.ok) {
      throw new DaemonError("bad_request", formatDiagnostics(result.diagnostics));
    }

    graph = graphView(result.graph);
  } else {
    graph = await call(context, routes.graph, {
      params: { slug: target },
      query: { workspace: context.cwd },
      body: undefined,
    });
  }

  if (format === "text") {
    printLine(text(graph));
  } else {
    printJson(graph);
  }
}
