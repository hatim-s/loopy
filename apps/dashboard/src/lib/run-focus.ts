import type { GraphView, ScopeCountsView } from "@loopy/contract";
import type { GraphModel, GraphNode } from "./graph";
import { firstInside } from "./run-marks";
import type { ScopeTuple } from "./view-models";

/** The map the reader is looking at, and the scope its item picker lists. */
export type MapFocus = {
  mapId: GraphNode["id"];
  /** Null when the map itself runs per item of an outer map with no item open. */
  parentScope: ScopeTuple | null;
  /** The selection is a node inside the map rather than the map. */
  inside: boolean;
};

/**
 * Where a node executes: the top level, or the open item of the map that owns it. Null when it
 * runs per item and that map has no item open.
 */
export function scopeOf(
  definition: GraphModel,
  item: ScopeTuple | null,
  nodeId: string,
): ScopeTuple | null {
  const owner = definition.nodes.find((node) => node.id === nodeId)?.maps.at(-1);

  if (owner === undefined) {
    return [];
  }

  const depth = item?.findIndex((part) => part.nodeId === owner) ?? -1;

  return item && depth >= 0 ? item.slice(0, depth + 1) : null;
}

/** The selected map, or the innermost map around the selected node. */
export function focusOf(
  definition: GraphModel,
  item: ScopeTuple | null,
  selected: string,
): MapFocus | null {
  const node = definition.nodes.find((entry) => entry.id === selected);

  if (node?.node.kind === "map") {
    return { mapId: node.id, parentScope: scopeOf(definition, item, node.id), inside: false };
  }

  const mapId = node?.maps.at(-1);

  return mapId === undefined
    ? null
    : { mapId, parentScope: scopeOf(definition, item, mapId), inside: true };
}

/**
 * Opening an item from the map's list moves to the first node it runs, where the item's input,
 * output and error live. From a node inside the map, the node stays. Null when the map is
 * unreachable because an outer item is closed.
 */
export function openItemTarget(
  focus: MapFocus,
  graph: GraphView,
  index: number,
): { item: ScopeTuple; node?: string } | null {
  if (focus.parentScope === null) {
    return null;
  }

  const item = [...focus.parentScope, { nodeId: focus.mapId, index }];

  return focus.inside ? { item } : { item, node: firstInside(graph, focus.mapId) ?? focus.mapId };
}

/** The counts the picker shows for the focused map in its scope. */
export function focusSummary(
  scopes: readonly ScopeCountsView[],
  focus: MapFocus,
): ScopeCountsView | undefined {
  const parent = JSON.stringify(focus.parentScope);

  return scopes.find(
    (summary) => summary.nodeId === focus.mapId && JSON.stringify(summary.parentScope) === parent,
  );
}
