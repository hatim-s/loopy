import type { ExecutionKey, ExecutionSpec, StoreEffect } from "../core/index.js";

export type Effect =
  | StoreEffect
  | { kind: "sample"; executionKey: ExecutionKey; valueKind: "uuid" | "random" }
  | { kind: "dispatch"; executionKey: ExecutionKey; attempt: number; spec: ExecutionSpec };
