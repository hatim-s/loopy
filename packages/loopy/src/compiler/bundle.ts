import { resolve } from "node:path";
import { bundleRefs, type Graph, type Node, sha256Hex } from "../core/index.js";
import { sourcePaths } from "../local/index.js";
import { commandParser } from "../sdk/graph-host.js";
import { checkImports } from "./module-imports.js";
import { runnerSource } from "./runner.js";
import { typescriptPaths } from "./source.js";
import type { Bundle, CompilerDiagnostic, ParserSource } from "./types.js";

async function buildModule(file: string, kind: "code" | "parser") {
  return Bun.build({
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
            contents: runnerSource(file, kind),
            loader: "ts",
          }));
        },
      },
      typescriptPaths,
      sourcePaths,
    ],
  });
}

async function buildNode(
  node: Extract<Node, { kind: "code" | "command" }>,
  parsers: Map<string, ParserSource>,
) {
  if (node.kind === "code") {
    return { file: node.module.path, result: await buildModule(node.module.path, "code") };
  }

  const parser = parsers.get(node.key)?.file ?? commandParser(node.key);

  if (!parser) {
    throw new Error(`Declare parser '${node.key}' in a module-level defineCommand descriptor.`);
  }

  const file = parsers.has(node.key) ? parser : resolve(import.meta.dir, "../sdk/graph", parser);

  return { file, result: await buildModule(file, "parser") };
}

type BundleResult =
  | { ok: true; bundles: Bundle[] }
  | { ok: false; diagnostics: CompilerDiagnostic[] };

export async function bundle(
  graph: Graph,
  parsers: Map<string, ParserSource>,
): Promise<BundleResult> {
  const bundles: Bundle[] = [];

  for (const { nodeId } of bundleRefs(graph)) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || (node.kind !== "code" && node.kind !== "command")) {
      continue;
    }

    const { file, result } = await buildNode(node, parsers);

    const output = result.outputs[0];

    if (!result.success || !output) {
      throw new Error(result.logs.join("\n"));
    }

    const diagnostics: CompilerDiagnostic[] = [];

    for (const emitted of result.outputs) {
      if (emitted.kind === "entry-point" || emitted.kind === "chunk") {
        checkImports(file, await emitted.text(), diagnostics);
      }
    }

    if (diagnostics.length > 0) {
      return {
        ok: false,
        diagnostics: diagnostics.map((value) => ({
          ...value,
          message: `Emitted bundle: ${value.message}`,
        })),
      };
    }

    const bytes = new Uint8Array(await output.arrayBuffer());
    const bundleHash = await sha256Hex(bytes);
    bundles.push({ nodeId: node.id, bundleHash, bytes });

    if (node.kind === "code") {
      node.module.bundleHash = bundleHash;
    } else if (node.parse !== null) {
      node.parse.bundleHash = bundleHash;
    }
  }

  return { ok: true, bundles };
}
