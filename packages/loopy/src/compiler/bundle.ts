import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Graph, Node } from "../core/index.js";
import { sourcePaths } from "../local/index.js";
import { commandParser } from "../sdk/graph-host.js";
import { runnerSource } from "./runner.js";
import { typescriptPaths } from "./source.js";
import type { Bundle, ParserSource } from "./types.js";

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
    return buildModule(node.module.path, "code");
  }

  const parser = parsers.get(node.key)?.file ?? commandParser(node.key);

  if (!parser) {
    throw new Error(`Declare parser '${node.key}' in a module-level defineCommand descriptor.`);
  }

  return buildModule(
    parsers.has(node.key) ? parser : resolve(import.meta.dir, "../sdk/graph", parser),
    "parser",
  );
}

export async function bundle(graph: Graph, parsers: Map<string, ParserSource>): Promise<Bundle[]> {
  const bundles: Bundle[] = [];

  for (const node of graph.nodes) {
    if (node.kind !== "code" && !(node.kind === "command" && node.parse !== null)) {
      continue;
    }

    const result = await buildNode(node, parsers);

    const output = result.outputs[0];

    if (!result.success || !output) {
      throw new Error(result.logs.join("\n"));
    }

    const bytes = new Uint8Array(await output.arrayBuffer());
    const bundleHash = createHash("sha256").update(bytes).digest("hex");
    bundles.push({ nodeId: node.id, bundleHash, bytes });

    if (node.kind === "code") {
      node.module.bundleHash = bundleHash;
    } else if (node.parse !== null) {
      node.parse.bundleHash = bundleHash;
    }
  }

  return bundles;
}
