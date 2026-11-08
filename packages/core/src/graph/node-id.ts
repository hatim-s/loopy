import { Schema } from "effect";
import { type NodeId, nodeIdSchema, type RefId, refIdSchema } from "./values";

const decodeNodeId = Schema.decodeUnknownSync(nodeIdSchema);

const decodeRefId = Schema.decodeUnknownSync(refIdSchema);

/**
 * The builder allocates ids as `<order>:<subgraph path>/<label>`. Call order keeps ids unique;
 * the path and label let readers group subgraph calls and name nodes without the source.
 */
export function formatNodeId(order: number, path: readonly string[], label: string): NodeId {
  return decodeNodeId(`${order}:${[...path, label].join("/")}`);
}

/** A control node's bindings, such as a map item, are named after the node that owns them. */
export function formatBindingId(owner: NodeId, name: string): RefId {
  return decodeRefId(`${owner}:${name}`);
}

/** Brands an id the graph already holds, or `input`, as a reference target. */
export function refId(id: string): RefId {
  return decodeRefId(id);
}

/**
 * Reads an id written by formatNodeId. The local part names a node within its subgraph call,
 * and the path before its last slash names that call. Top-level nodes have an empty path.
 * Refs that are not node ids, such as `input`, have no order.
 */
export function nodeIdParts(id: string) {
  const local = id.slice(id.indexOf(":") + 1);

  return { local, path: local.includes("/") ? local.slice(0, local.lastIndexOf("/")) : "" };
}
