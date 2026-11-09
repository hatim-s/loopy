import { resolve } from "node:path";
import { compile } from "@loopy/compiler";
import { type GraphView, graphView, routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { cliIO, diagnosticsError } from "../errors";
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

export const graph = defineCommand({
  path: ["graph"],
  summary: "Print a saved graph by name, or compile a file and print its graph",
  options: {
    format: {
      type: "choice",
      choices: ["json", "text"],
      default: "json",
      description: "Output format.",
    },
  },
  positionals: [{ name: "name|file", label: "Name or file" }],
  run: (cli) =>
    Effect.gen(function* () {
      const [target] = cli.args;
      let view: GraphView;

      if (yield* cliIO(() => Bun.file(resolve(cli.cwd, target)).exists())) {
        const result = yield* compile(resolve(cli.cwd, target));

        if (!result.ok) {
          return yield* diagnosticsError(result.diagnostics);
        }

        view = graphView(result.graph);
      } else {
        ({ graph: view } = yield* request(
          cli,
          `/loopies/${encodeURIComponent(target)}/graph?workspace=${encodeURIComponent(cli.cwd)}`,
          routes.graph.response,
        ));
      }

      if (cli.values.format === "text") {
        printLine(text(view));
      } else {
        printJson(view);
      }
    }),
});
