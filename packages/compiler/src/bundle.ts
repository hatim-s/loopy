import { createHash } from "node:crypto";
import type { Graph, Node } from "@loopy/core";
import { builtinParser } from "@loopy/sdk/graph-host";
import { Effect } from "effect";
import { AuthorDiagnostics, authorFailure, compilerIO } from "./errors";
import { checkImports } from "./module-imports";
import { runnerSource } from "./runner";
import { sourcePaths, typescriptPaths } from "./source-paths";
import type { Bundle, CompilerDiagnostic, ParserSource } from "./types";

function buildModule(module: ParserSource, kind: "code" | "parser") {
  return compilerIO("bundle module", module.file, () =>
    Bun.build({
      throw: false,
      entrypoints: ["loopy-runner:entry"],
      target: "bun",
      format: "esm",
      minify: true,
      plugins: [
        {
          name: "executable-bundle",
          setup(build) {
            build.onResolve({ filter: /^loopy-runner:entry$/ }, () => ({
              path: "entry",
              namespace: "loopy-runner",
            }));
            build.onLoad({ filter: /.*/, namespace: "loopy-runner" }, () => ({
              contents: runnerSource(module.file, module.exportName, kind),
              loader: "ts",
            }));
          },
        },
        typescriptPaths,
        sourcePaths,
      ],
    }),
  );
}

const buildNode = Effect.fn(function* (
  node: Extract<Node, { kind: "code" | "command" }>,
  parsers: Map<string, ParserSource>,
  entry: string,
) {
  if (node.kind === "code") {
    const module = { file: node.module.path, exportName: "default" };

    return { file: module.file, result: yield* buildModule(module, "code") };
  }

  const parser = parsers.get(node.key) ?? builtinParser(node.key);

  if (!parser) {
    return yield* authorFailure(
      "bundle_failed",
      entry,
      `Declare parser '${node.key}' in a module-level defineCommand descriptor.`,
    );
  }

  return { file: parser.file, result: yield* buildModule(parser, "parser") };
});

/** Returns the graph with each executable node pointing at the hash of its bundle. */
export const bundle = Effect.fn(function* (
  graph: Graph,
  parsers: Map<string, ParserSource>,
  entry: string,
) {
  const bundles: Bundle[] = [];
  const nodes: Node[] = [];

  for (const node of graph.nodes) {
    if (node.kind !== "code" && (node.kind !== "command" || node.parse === null)) {
      nodes.push(node);
      continue;
    }

    const { file, result } = yield* buildNode(node, parsers, entry);
    const output = result.outputs[0];

    if (!result.success || !output) {
      return yield* authorFailure("bundle_failed", file, result.logs.join("\n"));
    }

    const diagnostics: CompilerDiagnostic[] = [];

    for (const emitted of result.outputs) {
      if (emitted.kind === "entry-point" || emitted.kind === "chunk") {
        checkImports(
          file,
          yield* compilerIO("read emitted source", file, () => emitted.text()),
          diagnostics,
        );
      }
    }

    if (diagnostics.length > 0) {
      return yield* new AuthorDiagnostics({
        diagnostics: diagnostics.map((value) => ({
          ...value,
          message: `Emitted bundle: ${value.message}`,
        })),
      });
    }

    const bytes = new Uint8Array(
      yield* compilerIO("read bundle bytes", file, () => output.arrayBuffer()),
    );

    const bundleHash = createHash("sha256").update(bytes).digest("hex");
    bundles.push({ nodeId: node.id, bundleHash, bytes });

    nodes.push(
      node.kind === "code"
        ? { ...node, module: { ...node.module, bundleHash } }
        : { ...node, parse: node.parse && { ...node.parse, bundleHash } },
    );
  }

  return { graph: { ...graph, nodes }, bundles };
});
