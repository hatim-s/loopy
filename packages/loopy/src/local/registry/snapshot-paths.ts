import { dirname, isAbsolute, resolve } from "node:path";
import type { Command, Scalar, Value, Workflow, WorkflowNode } from "../../core/index.js";
import { isRecord, isString, validateWorkflow } from "../../core/index.js";

type Rewrite = (item: Value<Scalar>, cwd: string) => Value<Scalar>;

function isExplicitRelative(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

/**
 * Global workflows run from any directory, so their paths become absolute at
 * save time. Project workflows keep paths relative to the project.
 */
function pathRewriter(global: boolean): Rewrite {
  const rewrite: Rewrite = (item, cwd) => {
    if (isString(item)) {
      return global && isExplicitRelative(item) ? resolve(cwd, item) : item;
    }

    if (!isRecord(item)) {
      return item;
    }

    if ("$file" in item && isString(item.$file)) {
      return global ? resolve(cwd, item.$file) : item.$file;
    }

    if ("$op" in item && isString(item.$op) && Array.isArray(item.args)) {
      // Only marked paths are rewritten inside expressions; string fragments may be prose.
      // SAFETY: Workflow compilation checked every expression operand before path rewriting.
      const operands = item.args as Value<Scalar>[];

      return {
        ...item,
        args: operands.map((part) => (isString(part) ? part : rewrite(part, cwd))),
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

  // SAFETY: Compiled command operands preserve their scalar or reference kind; path rewriting only changes string paths.
  command.args = command.args.map((arg) => rewrite(arg, cwd)) as typeof command.args;

  if (command.stdin !== undefined) {
    // SAFETY: Path rewriting preserves stdin as a string literal or string-producing workflow operand.
    command.stdin = rewrite(command.stdin, cwd) as typeof command.stdin;
  }

  if (command.env) {
    // SAFETY: Each environment value retains its string-producing contract when paths are rewritten.
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
        // SAFETY: Conditions retain their boolean-producing operand contract; path rewriting only rewrites marked paths.
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
