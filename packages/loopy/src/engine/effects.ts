import type { ExecutionKey, ExecutionSpec, StoreEffect } from "../core/index.js";

export type Effect =
  | StoreEffect
  | { kind: "dispatch"; executionKey: ExecutionKey; attempt: number; spec: ExecutionSpec };
