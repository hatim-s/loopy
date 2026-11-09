import { canonicalJson } from "./canonical-json";
import type { ExecutionSpec } from "./executor";
import type { Graph, Node } from "./graph";

type CodeNode = Extract<Node, { kind: "code" }>;

type CommandNode = Extract<Node, { kind: "command" }>;

export type BundledNode = CodeNode | (CommandNode & { parse: NonNullable<CommandNode["parse"]> });

/** Code modules and command parsers carry bundles. */
export function carriesBundle(node: Node): node is BundledNode {
  return node.kind === "code" || (node.kind === "command" && node.parse !== null);
}

/** Bundles a graph carries, listed in node order. */
export function graphBundles(graph: Pick<Graph, "nodes">) {
  return graph.nodes.filter(carriesBundle).map((node) => ({
    nodeId: node.id,
    bundleHash: node.kind === "code" ? node.module.bundleHash : node.parse.bundleHash,
  }));
}

/** Bundles one attempt needs. The engine copies them from the node's bundle fields. */
export function specBundles(spec: ExecutionSpec): string[] {
  if (spec.kind === "code") {
    return [spec.bundleHash];
  }

  return spec.parse === null ? [] : [spec.parse.bundleHash];
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function revision(graph: Graph): Promise<string> {
  const hashes = graphBundles(graph).map(({ bundleHash }) => bundleHash);

  return sha256Hex(new TextEncoder().encode(canonicalJson(graph) + hashes.join("")));
}
