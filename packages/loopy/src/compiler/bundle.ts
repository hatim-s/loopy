import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import type { Graph, Node } from "../core/index.js";
import { sourcePaths } from "../local/index.js";
import { commandParser } from "../sdk/graph-host.js";
import { AuthorError, compilerIO } from "./errors.js";
import { checkImports } from "./module-imports.js";
import { runnerSource } from "./runner.js";
import { typescriptPaths } from "./source.js";
import type { Bundle, CompilerDiagnostic, ParserSource } from "./types.js";

function buildModule(file: string, kind: "code" | "parser") {
  return compilerIO("bundle module", file, () =>
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
              contents: runnerSource(file, kind),
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
    return { file: node.module.path, result: yield* buildModule(node.module.path, "code") };
  }

  const parser = parsers.get(node.key)?.file ?? commandParser(node.key);

  if (!parser) {
    return yield* Effect.fail(
      new AuthorError({
        code: "bundle_failed",
        file: entry,
        message: `Declare parser '${node.key}' in a module-level defineCommand descriptor.`,
      }),
    );
  }

  const file = parsers.has(node.key) ? parser : resolve(import.meta.dir, "../sdk/graph", parser);

  return { file, result: yield* buildModule(file, "parser") };
});

type BundleResult =
  | { ok: true; bundles: Bundle[] }
  | { ok: false; diagnostics: CompilerDiagnostic[] };

export const bundle = Effect.fn(function* (
  graph: Graph,
  parsers: Map<string, ParserSource>,
  entry: string,
) {
  const bundles: Bundle[] = [];

  for (const node of graph.nodes) {
    if (node.kind !== "code" && !(node.kind === "command" && node.parse !== null)) {
      continue;
    }

    const { file, result } = yield* buildNode(node, parsers, entry);

    const output = result.outputs[0];

    if (!result.success || !output) {
      return yield* Effect.fail(
        new AuthorError({ code: "bundle_failed", file, message: result.logs.join("\n") }),
      );
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
      return {
        ok: false as const,
        diagnostics: diagnostics.map((value) => ({
          ...value,
          message: `Emitted bundle: ${value.message}`,
        })),
      };
    }

    const bytes = new Uint8Array(
      yield* compilerIO("read bundle bytes", file, () => output.arrayBuffer()),
    );

    const bundleHash = createHash("sha256").update(bytes).digest("hex");
    bundles.push({ nodeId: node.id, bundleHash, bytes });

    if (node.kind === "code") {
      node.module.bundleHash = bundleHash;
    } else if (node.parse !== null) {
      node.parse.bundleHash = bundleHash;
    }
  }

  return { ok: true, bundles } satisfies BundleResult;
});
