import {
  codeNodeSchema,
  commandNodeSchema,
  DIAGNOSTIC_CODES,
  graphRecord,
  graphSchema,
  nodeIdSchema,
  nodeSchema,
  struct,
  valueSchema,
} from "@loopy/core";
import { Schema } from "effect";

type NodeMember = (typeof nodeSchema.members)[number];

// Only executables name private registry files; every other node's view is its stored shape.
function isPublicNode(
  member: NodeMember,
): member is Exclude<NodeMember, typeof codeNodeSchema | typeof commandNodeSchema> {
  return member !== codeNodeSchema && member !== commandNodeSchema;
}

// Views drop module paths and parser bundle hashes.
export const nodeViewSchema = Schema.Union([
  struct({ ...codeNodeSchema.fields, module: struct({ name: Schema.String }) }),
  struct({
    ...commandNodeSchema.fields,
    parse: Schema.NullOr(struct({ input: graphRecord(Schema.mutableKey(valueSchema)) })),
  }),
  ...nodeSchema.members.filter(isPublicNode),
]);

export const graphViewSchema = struct({
  ...graphSchema.fields,
  nodes: Schema.Array(nodeViewSchema).pipe(Schema.mutable),
  warnings: Schema.Array(
    struct({
      code: Schema.Literals(DIAGNOSTIC_CODES),
      message: Schema.String,
      nodeId: Schema.NullOr(nodeIdSchema),
      label: Schema.NullOr(Schema.String),
    }),
  ).pipe(Schema.mutable),
});

export type GraphView = Schema.Schema.Type<typeof graphViewSchema>;

export const graphRevisionViewSchema = struct({ revision: Schema.String, graph: graphViewSchema });

export type GraphRevisionView = Schema.Schema.Type<typeof graphRevisionViewSchema>;

/**
 * The builder allocates ids as `<order>:<subgraph path>/<label>`, so the part after the colon
 * names a node within its subgraph call and the path before the last slash names that call.
 * Top-level nodes have an empty path. Refs that are not node ids, such as `input`, have no order.
 */
export function nodeIdParts(id: string) {
  const local = id.slice(id.indexOf(":") + 1);

  return { local, path: local.includes("/") ? local.slice(0, local.lastIndexOf("/")) : "" };
}
