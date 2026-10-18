import { resolve } from "node:path";
import { compile } from "../../compiler/index.js";
import { type GraphView, graphView, routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
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

  if (format !== "json" && format !== "text") {
    throw new Error("Use --format json or --format text.");
  }

  let graph: GraphView;

  if (await Bun.file(resolve(context.cwd, target)).exists()) {
    const result = await compile(resolve(context.cwd, target), { home: context.home });

    if (!result.ok) {
      throw new Error(
        result.diagnostics
          .map(
            (value) =>
              `${value.source.module}:${value.source.line}:${value.source.column} [${value.code}] ${value.message}`,
          )
          .join("\n"),
      );
    }

    graph = graphView(result.graph);
  } else {
    graph = await request(
      context,
      `/loopies/${encodeURIComponent(target)}/graph?workspace=${encodeURIComponent(context.cwd)}`,
      routes.graph.response,
    );
  }

  if (format === "text") {
    printLine(text(graph));
  } else {
    printJson(graph);
  }
}
