import { Schema } from "effect";
import { counter, struct } from "../codec";
import { nodeIdSchema } from "./values";

export const executionKeySchema = struct({
  runId: Schema.String,
  nodeId: nodeIdSchema,
  scope: Schema.Array(struct({ nodeId: nodeIdSchema, index: counter })).pipe(Schema.mutable),
});

export type ExecutionKey = Schema.Schema.Type<typeof executionKeySchema>;

export function executionKeyString(key: ExecutionKey): string {
  // Quoting keeps ids unambiguous so stores and wire consumers share one execution identity.
  return [
    JSON.stringify(key.runId),
    JSON.stringify(key.nodeId),
    ...key.scope.map(({ nodeId, index }) => JSON.stringify([nodeId, index])),
  ].join("/");
}

export function scopeHasPrefix(scope: ExecutionKey["scope"], prefix: ExecutionKey["scope"]) {
  return prefix.every(
    (part, depth) => scope[depth]?.nodeId === part.nodeId && scope[depth]?.index === part.index,
  );
}
