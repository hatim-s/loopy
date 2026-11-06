import { resolve } from "node:path";
import { compile } from "@loopy/compiler";
import { type GraphView, graphView, routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { type CliContext, requireTarget } from "../context";
import { CliError, cliIO, diagnosticsError } from "../errors";
import { printJson, printLine } from "../output";

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

export function runGraph(context: CliContext) {
  return Effect.gen(function* () {
    const target = yield* requireTarget(context, "Name or file");
    const format = context.values.format ?? "json";

    if (format !== "json" && format !== "text") {
      return yield* Effect.fail(new CliError({ message: "Use --format json or --format text." }));
    }

    let graph: GraphView;

    if (yield* cliIO(() => Bun.file(resolve(context.cwd, target)).exists())) {
      const result = yield* compile(resolve(context.cwd, target));

      if (!result.ok) {
        return yield* Effect.fail(diagnosticsError(result.diagnostics));
      }

      graph = graphView(result.graph);
    } else {
      ({ graph } = yield* request(
        context,
        `/loopies/${encodeURIComponent(target)}/graph?workspace=${encodeURIComponent(context.cwd)}`,
        routes.graph.response,
      ));
    }

    if (format === "text") {
      printLine(text(graph));
    } else {
      printJson(graph);
    }
  });
}
