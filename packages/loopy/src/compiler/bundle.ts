import { resolve } from "node:path";
import { bundleRefs, type Graph, type Node, sha256Hex } from "../core/index.js";
import { commandParser } from "../sdk/graph-host.js";
import { checkImports } from "./code-module.js";
import { runnerSource } from "./runner.js";
import { sourcePaths, typescriptPaths } from "./source.js";
import type { Bundle, CompilerDiagnostic } from "./types.js";

async function buildModule(file: string, kind: "code" | "parser") {
  return Bun.build({
    entrypoints: ["loopy-runner:entry"],
    target: "bun",
    format: "esm",
    minify: true,
    throw: false,
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
  parsers: Map<string, string>,
) {
  if (node.kind === "code") {
    return { file: node.module.path, result: await buildModule(node.module.path, "code") };
  }

  // SAFETY: Restriction records custom parsers, and SDK descriptors supply every built-in parser.
  const parser = (parsers.get(node.key) ?? commandParser(node.key)) as string;

  const file = parsers.has(node.key) ? parser : resolve(import.meta.dir, "../sdk/graph", parser);

  return { file, result: await buildModule(file, "parser") };
}

type BundleResult =
  | { ok: true; bundles: Bundle[] }
  | { ok: false; diagnostics: CompilerDiagnostic[] };

export async function bundle(graph: Graph, parsers: Map<string, string>): Promise<BundleResult> {
  const bundles: Bundle[] = [];

  for (const { nodeId } of bundleRefs(graph)) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);

    if (!node || (node.kind !== "code" && node.kind !== "command")) {
      continue;
    }

    const { file, result } = await buildNode(node, parsers);

    const output = result.outputs[0];

    if (!result.success || !output) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "bundle_failed",
            message: result.logs.join("\n"),
            source: { module: file, line: 1, column: 1 },
          },
        ],
      };
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
        diagnostics: diagnostics.map(() => ({
          code: "dynamic_code",
          message: "A bundled dependency loads code at run time.",
          source: { module: file, line: 1, column: 1 },
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
