import { basename } from "node:path";
import type { PutLoopyBody, SourceArtifact } from "@loopy/contract";
import { carriesBundle, type Graph, graphBundles, revision, sha256Hex } from "@loopy/core";
import { loopy } from "@loopy/sdk";

const STAND_IN_BUNDLE = new TextEncoder().encode("export default () => null;\n");

export async function compiledBody(
  name: string,
  path: string,
  meta: Partial<PutLoopyBody["graph"]["meta"]> &
    Partial<PutLoopyBody["source"]> &
    Partial<Pick<PutLoopyBody["graph"], "input">> = {},
): Promise<PutLoopyBody> {
  const graph = loopy(name, { input: {}, run: () => null });
  graph.input = meta.input ?? {};

  graph.meta = {
    description: meta.description ?? null,
    schedule: meta.schedule ?? null,
    secrets: meta.secrets ?? [],
    mode: meta.mode ?? "sandbox",
    scope: meta.scope ?? "project",
  };

  return builtBody(graph, {
    path,
    workspace: meta.workspace ?? path.slice(0, path.lastIndexOf("/")),
  });
}

/**
 * The save body for a graph built in-process. Each code node and parser gets the same stand-in
 * bundle a save would otherwise compile, so the body passes artifact validation. Given source
 * text, the body also pins it, without node ranges.
 */
export async function builtBody(
  graph: Graph,
  source: PutLoopyBody["source"],
  content?: string,
): Promise<PutLoopyBody> {
  withBundles(graph, await sha256Hex(STAND_IN_BUNDLE));
  const hash = await revision(graph);

  return {
    graph,
    revision: hash,
    bundles: graphBundles(graph).map((bundle) => ({ ...bundle, bytes: STAND_IN_BUNDLE })),
    replace: false,
    source,
    ...(content !== undefined && {
      sourceArtifact: {
        version: 1,
        status: "available",
        revision: hash,
        files: [{ id: "file-0", path: basename(source.path), content }],
        ranges: [],
      } satisfies SourceArtifact,
    }),
  };
}

/** Gives every code node and parser a bundle hash, as a save would after bundling. */
export function withBundles(graph: Graph, hash = "a".repeat(64)): Graph {
  for (const node of graph.nodes.filter(carriesBundle)) {
    if (node.kind === "code") {
      node.module.bundleHash = hash;
    } else {
      node.parse.bundleHash = hash;
    }
  }

  return graph;
}
