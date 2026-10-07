import { dirname, isAbsolute, resolve } from "node:path";
import type { Command, Workflow, WorkflowNode } from "../../core/index.js";
import { isRecord, validateWorkflow } from "../../core/index.js";

type Rewrite = (item: unknown, cwd: string) => unknown;

function isExplicitRelative(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

/**
 * Global workflows run from any directory, so their paths become absolute at
 * save time. Project workflows keep paths relative to the project.
 */
function pathRewriter(global: boolean): Rewrite {
  const rewrite: Rewrite = (item, cwd) => {
    if (typeof item === "string") {
      return global && isExplicitRelative(item) ? resolve(cwd, item) : item;
    }
    if (!isRecord(item)) {
      return item;
    }
    if (typeof item.$file === "string") {
      return global ? resolve(cwd, item.$file) : item.$file;
    }
    if (typeof item.$op === "string" && Array.isArray(item.args)) {
      // Only marked paths are rewritten inside expressions; string fragments may be prose.
      return {
        ...item,
        args: item.args.map((part) => (typeof part === "string" ? part : rewrite(part, cwd))),
      };
    }
    return item;
  };
  return rewrite;
}

function snapshotCommand(command: Command, base: string, global: boolean, rewrite: Rewrite) {
  const cwd = resolve(base, command.cwd ?? ".");
  if (global) {
    if (command.cwd !== undefined) {
      command.cwd = cwd;
    }
    if (isAbsolute(command.program) || command.program.includes("/")) {
      command.program = resolve(cwd, command.program);
    }
  }
  command.args = command.args.map((arg) => rewrite(arg, cwd)) as typeof command.args;
  if (command.stdin !== undefined) {
    command.stdin = rewrite(command.stdin, cwd) as typeof command.stdin;
  }
  if (command.env) {
    command.env = Object.fromEntries(
      Object.entries(command.env).map(([key, item]) => [key, rewrite(item, cwd)]),
    ) as typeof command.env;
  }
}

/** Rewrites the paths in a compiled workflow in place relative to its source file. */
export function snapshotPaths(workflow: Workflow, source: string): Workflow {
  const global = workflow.config?.scope === "global";
  const base = dirname(source);
  const rewrite = pathRewriter(global);
  const walk = (nodes: WorkflowNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "condition") {
        node.test = rewrite(node.test, base) as typeof node.test;
        walk(node.then);
        walk(node.else);
        continue;
      }
      snapshotCommand(node.command, base, global, rewrite);
    }
  };
  walk(workflow.nodes);
  validateWorkflow(workflow);
  return workflow;
}
