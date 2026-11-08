import type { PutLoopyBody } from "@loopy/contract";
import { type Graph, revision } from "@loopy/core";
import { loopy } from "@loopy/sdk/graph";

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

  return {
    graph,
    revision: await revision(graph),
    bundles: [],
    replace: false,
    source: {
      path,
      workspace: meta.workspace ?? path.slice(0, path.lastIndexOf("/")),
    },
  };
}

/** Gives every code node a stand-in bundle hash, as a save would after bundling. */
export function withBundles(graph: Graph): Graph {
  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}
