import { canonicalJson } from "./canonical-json";
import type { Graph } from "./graph";

/** Code modules and command parsers carry bundles, listed in node order. */
export function graphBundles(graph: Pick<Graph, "nodes">) {
  return graph.nodes.flatMap((node) =>
    node.kind === "code"
      ? [{ nodeId: node.id, bundleHash: node.module.bundleHash }]
      : node.kind === "command" && node.parse !== null
        ? [{ nodeId: node.id, bundleHash: node.parse.bundleHash }]
        : [],
  );
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function revision(graph: Graph): Promise<string> {
  const hashes = graphBundles(graph).map(({ bundleHash }) => bundleHash);

  return sha256Hex(new TextEncoder().encode(canonicalJson(graph) + hashes.join("")));
}
