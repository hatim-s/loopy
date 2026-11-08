import { codeNodeSchema, commandNodeSchema, graphSchema, nodeSchema, struct } from "@loopy/core";
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
    // Whether a parser shapes the output in place of the raw command result.
    parse: Schema.Boolean,
  }),
  ...nodeSchema.members.filter(isPublicNode),
]);

export const graphViewSchema = struct({
  ...graphSchema.fields,
  nodes: Schema.Array(nodeViewSchema).pipe(Schema.mutable),
});

export type GraphView = Schema.Schema.Type<typeof graphViewSchema>;

export const graphRevisionViewSchema = struct({ revision: Schema.String, graph: graphViewSchema });

export type GraphRevisionView = Schema.Schema.Type<typeof graphRevisionViewSchema>;
