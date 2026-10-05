import type {
  D1Database,
  DurableObjectNamespace,
  DurableObjectState,
} from "@cloudflare/workers-types";
import type { WorkspaceProvider } from "../../../packages/loopy/src/runtime/durable-runner.js";
import type { RemoteExecutor } from "../../../packages/loopy/src/runtime/remote-executor.js";
import type { ClerkConfig } from "./auth.js";
export type ExecutorService = RemoteExecutor & {
  provisionWorkspace: WorkspaceProvider["provision"];
  inspectWorkspace: WorkspaceProvider["inspect"];
};
export type CloudEnv = ClerkConfig & {
  DB: D1Database;
  COORDINATORS: DurableObjectNamespace;
  EXECUTOR: ExecutorService;
  RUNTIME_BUILD: string;
};
export type CoordinatorState = DurableObjectState;
