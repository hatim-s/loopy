import type { StoreEffect } from "../effects";
import type { ExecutionSpec } from "../executor";
import type { ExecutionKey } from "../graph/key";

export type EngineEffect =
  | StoreEffect
  | { kind: "sample"; executionKey: ExecutionKey; valueKind: "uuid" | "random" }
  | { kind: "dispatch"; executionKey: ExecutionKey; attempt: number; spec: ExecutionSpec };
