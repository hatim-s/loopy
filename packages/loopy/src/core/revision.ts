import { canonicalJson } from "./canonical-json.js";
import type { Graph } from "./graph.js";

export function revisionInput(graph: Graph): string {
  const hashes = graph.nodes.flatMap((node) =>
    node.kind === "code"
      ? [node.module.bundleHash]
      : node.kind === "command" && node.parse !== null
        ? [node.parse.bundleHash]
        : [],
  );

  return canonicalJson(graph) + hashes.join("");
}

export async function revision(graph: Graph): Promise<string> {
  const bytes = new TextEncoder().encode(revisionInput(graph));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
