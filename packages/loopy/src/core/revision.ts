import { canonicalJson } from "./canonical-json.js";
import type { Graph, NodeId } from "./graph.js";

export function bundleRefs(graph: Graph): { nodeId: NodeId; bundleHash: string | null }[] {
  return graph.nodes.flatMap((node) => {
    if (node.kind === "code") {
      return [{ nodeId: node.id, bundleHash: node.module.bundleHash }];
    }
    if (node.kind === "command" && node.parse !== null) {
      return [{ nodeId: node.id, bundleHash: node.parse.bundleHash }];
    }
    return [];
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function revision(graph: Graph): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(graph)));
}
