import type { PutLoopyBody } from "../src/contract/index.js";
import { revision } from "../src/core/index.js";
import { loopy } from "../src/sdk/graph/index.js";

export async function compiledBody(
  name: string,
  path: string,
  meta: Partial<PutLoopyBody["graph"]["meta"]> & Partial<PutLoopyBody["source"]> = {},
): Promise<PutLoopyBody> {
  const { graph } = loopy(name, { input: {}, run: () => null });

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
