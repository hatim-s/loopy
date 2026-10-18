import type { Node } from "./graph.js";
import type { Json } from "./model.js";
import type { ExecutionKey } from "./node-run.js";

export type ExecutionSpec =
  | { kind: "code"; bundleHash: string; input: Record<string, Json>; timeoutMs: number }
  | {
      kind: "command";
      node: Extract<Node, { kind: "command" }>;
      argv: string[];
      flags: Record<string, Json>;
      cwd: string | null;
      env: Record<string, string>;
      stdin: string | null;
      parse: { bundleHash: string; input: Record<string, Json> } | null;
    };

export const EXECUTION_ERROR_CODES = [
  "execution",
  "exit",
  "protocol",
  "validation",
  "output_limit",
  "uncertain",
] as const;

export type ExecutionError = { code: (typeof EXECUTION_ERROR_CODES)[number]; message: string };

export type AttemptLog = { message: string; data: Json };

export type ExecutionResult =
  | { kind: "succeeded"; output: Json; logs: AttemptLog[] }
  | { kind: "failed"; error: ExecutionError; exitCode: number | null; logs: AttemptLog[] };

export type Receipt =
  | { kind: "none" }
  | { kind: "started" }
  | { kind: "finished"; result: ExecutionResult };

export interface Executor {
  execute(
    executionKey: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
    signal: AbortSignal,
  ): Promise<ExecutionResult>;
  lookup(executionKey: ExecutionKey, attempt: number): Promise<Receipt>;
}
