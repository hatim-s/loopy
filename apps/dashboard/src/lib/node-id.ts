/**
 * The builder allocates ids as `<order>:<subgraph path>/<label>`, so the part after the colon
 * names a node within its subgraph call and the path before the last slash names that call.
 * Top-level nodes have an empty path. Refs that are not node ids, such as `input`, have no order.
 */
export function nodeIdParts(id: string) {
  const local = id.slice(id.indexOf(":") + 1);

  return { local, path: local.includes("/") ? local.slice(0, local.lastIndexOf("/")) : "" };
}
