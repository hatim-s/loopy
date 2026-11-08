import { type BundledNode, carriesBundle, type Graph, type Node, sha256Hex } from "@loopy/core";
import { runnerSource } from "@loopy/runtime/executor/protocol";
import { builtinParser } from "@loopy/sdk/graph-host";
import { Effect } from "effect";
import { AuthorDiagnostics, authorFailure, compilerIO } from "./errors";
import { checkImports } from "./module-imports";
import { moduleFile, sourcePaths, typescriptPaths } from "./source-paths";
import type { Bundle, CompilerDiagnostic } from "./types";

type ModuleExport = { file: string; exportName: string };

function buildModule(module: ModuleExport, kind: "code" | "parser") {
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

const buildNode = Effect.fn(function* (node: BundledNode, entry: string) {
  if (node.kind === "code") {
    const module = { file: moduleFile(entry, node.module.path), exportName: "default" };

    return { file: module.file, result: yield* buildModule(module, "code") };
  }

  const parser =
    node.parse.module === null
      ? builtinParser(node.key)
      : { file: moduleFile(entry, node.parse.module), exportName: "default" };

  if (!parser) {
    return yield* authorFailure(
      "bundle_failed",
      entry,
      `Command '${node.key}' has no built-in parser. Give its descriptor a parse module.`,
    );
  }

  return { file: parser.file, result: yield* buildModule(parser, "parser") };
});

/** Returns the graph with each executable node pointing at the hash of its bundle. */
export const bundle = Effect.fn(function* (graph: Graph, entry: string) {
  const bundles: Bundle[] = [];
  const nodes: Node[] = [];

  for (const node of graph.nodes) {
    if (!carriesBundle(node)) {
      nodes.push(node);
      continue;
    }

    const { file, result } = yield* buildNode(node, entry);
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

    const bundleHash = yield* compilerIO("hash bundle", file, () => sha256Hex(bytes));
    bundles.push({ nodeId: node.id, bundleHash, bytes });

    nodes.push(
      node.kind === "code"
        ? { ...node, module: { ...node.module, bundleHash } }
        : { ...node, parse: { ...node.parse, bundleHash } },
    );
  }

  return { graph: { ...graph, nodes }, bundles };
});
