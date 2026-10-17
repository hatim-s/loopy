import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { Graph, Node } from "../core/index.js";
import { inlineImportMeta, sourcePaths } from "../local/index.js";
import { builtinCommandKeys } from "../sdk/graph-host.js";
import { runnerSource } from "./runner.js";
import { typescriptPaths } from "./source.js";
import type { Bundle, ParserSource } from "./types.js";

async function buildModule(file: string, parser: ParserSource | null) {
  const virtual = resolve(dirname(file), ".loopy-command-parser.ts");

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
            contents: runnerSource(
              parser === null ? file : virtual,
              parser === null ? "code" : "parser",
            ),
            loader: "ts",
          }));

          if (parser !== null) {
            build.onResolve({ filter: /\.loopy-command-parser\.ts$/ }, () => ({
              path: virtual,
              namespace: "loopy-parser",
            }));
            build.onLoad({ filter: /.*/, namespace: "loopy-parser" }, () => ({
              contents: inlineImportMeta(parser.file, "ts", parser.source),
              loader: "ts",
              resolveDir: dirname(parser.file),
            }));
          }
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
    return buildModule(node.module.path, null);
  }

  if (!parsers.has(node.key) && !builtinCommandKeys.includes(node.key)) {
    throw new Error(`Declare parser '${node.key}' in a module-level defineCommand descriptor.`);
  }

  const parser = parsers.get(node.key) ?? {
    file: resolve(import.meta.dir, "parser.ts"),
    source: `import {commandParser} from ${JSON.stringify(resolve(import.meta.dir, "../sdk/graph-host.js"))}; export default commandParser(${JSON.stringify(node.key)}, ${JSON.stringify(process.platform)});`,
  };

  return buildModule(parser.file, parser);
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
