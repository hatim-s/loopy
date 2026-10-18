import type { PutLoopyBody } from "../src/contract/index.js";
import { revision } from "../src/core/index.js";
import { loopy } from "../src/sdk/graph/index.js";

export async function compiledBody(
  name: string,
  path: string,
  meta: Partial<PutLoopyBody["graph"]["meta"]> & Partial<PutLoopyBody["source"]> = {},
): Promise<PutLoopyBody> {
  const { graph } = loopy(name, {
    input: {},
    description: meta.description ?? undefined,
    schedule: meta.schedule ?? undefined,
    secrets: meta.secrets,
    mode: meta.mode,
    scope: meta.scope,
    run: () => null,
  });

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
