import { revision } from "../src/compiler/revision.js";
import type { PutLoopyBody } from "../src/contract/index.js";
import { loopy } from "../src/sdk/graph/index.js";

export function compiledBody(
  name: string,
  path: string,
  source: Partial<PutLoopyBody["source"]> = {},
): PutLoopyBody {
  const { graph } = loopy({ name, input: {}, run: () => null });

  return {
    graph,
    revision: revision(graph, []),
    bundles: [],
    replace: false,
    source: {
      path,
      workspace: source.workspace ?? path.slice(0, path.lastIndexOf("/")),
      scope: "project",
      description: null,
      mode: "sandbox",
      secrets: [],
      schedule: null,
      ...source,
    },
  };
}
