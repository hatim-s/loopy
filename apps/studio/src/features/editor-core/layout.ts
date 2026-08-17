import type { WorkflowDefinition } from "@loopy/contracts";
import type { EditorPosition } from "./types.ts";

const X_GAP = 280;
const Y_GAP = 150;

/** Deterministic, dependency-free layered layout for the visual editor. */
export function autoLayout(document: WorkflowDefinition): Record<string, EditorPosition> {
  const incoming = new Map(document.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of document.edges) {
    if (!incoming.has(edge.target) || !incoming.has(edge.source)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const layer = new Map<string, number>();
  const queue = document.nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  for (const id of queue) layer.set(id, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    if (!source) continue;
    for (const target of outgoing.get(source) ?? []) {
      layer.set(target, Math.max(layer.get(target) ?? 0, (layer.get(source) ?? 0) + 1));
      const remaining = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }

  const positions: Record<string, EditorPosition> = {};
  const buckets = new Map<number, string[]>();
  document.nodes.forEach((node, index) => {
    const depth = layer.get(node.id) ?? index;
    buckets.set(depth, [...(buckets.get(depth) ?? []), node.id]);
  });
  for (const [depth, ids] of [...buckets.entries()].sort(([left], [right]) => left - right)) {
    ids.sort((left, right) => left.localeCompare(right));
    ids.forEach((id, row) => {
      positions[id] = { x: depth * X_GAP, y: row * Y_GAP };
    });
  }
  return positions;
}
