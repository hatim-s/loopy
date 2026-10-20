import dagre from "@dagrejs/dagre";
import type { GraphModel, GraphNodeModel, NodeRole } from "./graph.ts";

type Size = { width: number; height: number };

/** Node boxes have fixed sizes per role so layout runs before React measures anything. */
export const NODE_SIZE = {
  work: { width: 224, height: 60 },
  control: { width: 188, height: 40 },
  wait: { width: 204, height: 48 },
  value: { width: 184, height: 34 },
  fail: { width: 184, height: 34 },
  // Joins only merge scopes back together, so they draw as track junctions.
  junction: { width: 12, height: 12 },
  end: { width: 30, height: 30 },
} as const satisfies Record<NodeRole, Size>;

export function nodeSize(node: GraphNodeModel): Size {
  return NODE_SIZE[node.role];
}

type Point = { x: number; y: number };

export type Box = Point & Size;

/**
 * A frame drawn behind a control node and the nodes inside its scope, or behind the nodes one
 * subgraph call expanded into. `parent` is the frame this one nests inside.
 */
export type GraphGroup = {
  id: string;
  kind: "scope" | "subgraph";
  /** The control node id for a scope, the subgraph path for a subgraph. */
  owner: string;
  parent: string | null;
  depth: number;
};

export type GraphLayout = {
  /** The whole drawing, margins included. */
  size: Size;
  nodes: Map<string, Box>;
  groups: (GraphGroup & { box: Box })[];
  /** Polyline routes from dagre, in flow coordinates, with a label anchor where one fits. */
  edges: Map<string, { points: Point[]; label: Point | null }>;
};

// The builder allocates ids as `<order>:<subgraph path>/<label>`, so the path before the last
// slash names the subgraph call a node came from. Top-level nodes have an empty path.
function subgraphPath(id: string): string {
  const name = id.slice(id.indexOf(":") + 1);

  return name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
}

function parentPaths(path: string, outer: string): string[] {
  const parts = path.split("/");
  const paths: string[] = [];

  for (let end = (outer === "" ? 0 : outer.split("/").length) + 1; end <= parts.length; end += 1) {
    paths.push(parts.slice(0, end).join("/"));
  }

  return paths;
}

/**
 * Which frame each node sits in. Scopes come from `node.scope`. Subgraph frames come from the
 * id path, and a call is a contiguous run of nodes in builder order, so two calls of the same
 * subgraph far apart get two frames. Back-to-back calls of one subgraph share a frame, since
 * nothing in the graph tells them apart.
 */
export function graphGroups(model: GraphModel) {
  const groups = new Map<string, GraphGroup>();
  const parentOf = new Map<string, string | null>();
  // The latest open frame per subgraph path, closed when builder order leaves the path.
  const open = new Map<string, string>();

  const outerOf = (node: GraphNodeModel, index: number): string | null => {
    const scope = node.node.scope === null ? null : `scope:${node.node.scope}`;
    const outer = node.node.scope === null ? "" : subgraphPath(node.node.scope);
    const path = subgraphPath(node.id);

    if (path === outer || !path.startsWith(outer)) {
      return scope;
    }

    let parent = scope;

    for (const step of parentPaths(path, outer)) {
      const id = open.get(step) ?? `subgraph:${step}@${index}`;
      open.set(step, id);

      if (!groups.has(id)) {
        groups.set(id, { id, kind: "subgraph", owner: step, parent, depth: 0 });
      }

      parent = id;
    }

    return parent;
  };

  model.nodes.forEach((node, index) => {
    const path = subgraphPath(node.id);

    for (const step of open.keys()) {
      if (path !== step && !path.startsWith(`${step}/`)) {
        open.delete(step);
      }
    }

    const outer = outerOf(node, index);

    if (node.role === "control") {
      const id = `scope:${node.id}`;
      groups.set(id, { id, kind: "scope", owner: node.id, parent: outer, depth: 0 });
      parentOf.set(node.id, id);
    } else {
      parentOf.set(node.id, outer);
    }
  });

  for (const group of groups.values()) {
    let depth = 0;
    let parent = group.parent;

    while (parent !== null) {
      depth += 1;
      parent = groups.get(parent)?.parent ?? null;
    }

    group.depth = depth;
  }

  return { groups: [...groups.values()], parentOf };
}

const LABEL_H = 18;

const ARM_EDGES = new Set<GraphModel["edges"][number]["kind"]>([
  "yes",
  "no",
  "case",
  "each",
  "cleanup",
  "rescue",
]);

/** Mono glyphs at 10px run about 6px wide, plus the chip's padding. */
function labelSize(label: string): Size {
  return { width: label.length * 6.2 + 14, height: LABEL_H };
}

/**
 * A left-to-right layered layout with frames for scopes and subgraph calls. Dagre breaks
 * cycles itself, which matters for map bodies whose join edges point back at the map, and it
 * reserves room for edge labels so they never sit on a node.
 */
export function layoutGraph(model: GraphModel): GraphLayout {
  const graph = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  graph.setGraph({
    rankdir: "LR",
    nodesep: 22,
    ranksep: 46,
    edgesep: 14,
    marginx: 24,
    marginy: 24,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const { groups, parentOf } = graphGroups(model);

  for (const group of groups) {
    graph.setNode(group.id, {});
  }

  for (const group of groups) {
    if (group.parent !== null) {
      graph.setParent(group.id, group.parent);
    }
  }

  for (const node of model.nodes) {
    graph.setNode(node.id, { ...nodeSize(node) });
    const parent = parentOf.get(node.id) ?? null;

    if (parent !== null) {
      graph.setParent(node.id, parent);
    }
  }

  for (const edge of model.edges) {
    graph.setEdge(
      edge.from,
      edge.to,
      {
        // Heavy arm entries keep a short arm beside its control node instead of letting dagre
        // slide it toward the merge, where it would hang off one long track.
        weight: ARM_EDGES.has(edge.kind) ? 4 : 1,
        ...(edge.label !== null && { ...labelSize(edge.label), labelpos: "c" }),
      },
      edge.id,
    );
  }

  // A map's body joins back to the map, so dagre reverses that edge and would rank whatever
  // follows the map beside its body. These unrouted edges hold the continuation after the body.
  const maps = new Set(
    model.nodes.filter((node) => node.node.kind === "map").map((node) => node.id),
  );

  for (const back of model.edges.filter((edge) => edge.kind === "join" && maps.has(edge.to))) {
    for (const next of model.edges.filter(
      (edge) => edge.from === back.to && edge.kind === "next",
    )) {
      graph.setEdge(back.from, next.to, { weight: 2 }, `after:${back.id}:${next.id}`);
    }
  }

  dagre.layout(graph);

  const box = (id: string): Box => {
    const { x = 0, y = 0, width = 0, height = 0 } = graph.node(id);

    return { x: x - width / 2, y: y - height / 2, width, height };
  };

  const { width = 0, height = 0 } = graph.graph();

  return {
    size: { width, height },
    nodes: new Map(model.nodes.map((node) => [node.id, box(node.id)])),
    groups: groups.map((group) => ({ ...group, box: box(group.id) })),
    edges: new Map(
      model.edges.map((edge) => {
        const route = graph.edge({ v: edge.from, w: edge.to, name: edge.id });

        return [
          edge.id,
          {
            points: route.points ?? [],
            label:
              edge.label !== null && route.x !== undefined && route.y !== undefined
                ? { x: route.x, y: route.y }
                : null,
          },
        ];
      }),
    ),
  };
}
