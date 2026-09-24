import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workflow, WorkflowNode } from "./model.ts";
import { compileWorkflow, validateWorkflow } from "./workflow.ts";

export const defaultHome = () => resolve(process.env.LOOPY_HOME ?? join(homedir(), ".loopy", "v2"));

export type SavedWorkflow = { workflow: Workflow; source: string; updatedAt: string };
export type WorkflowSummary = {
  slug: string;
  description?: string;
  nodeCount: number;
  updatedAt: string;
};

export function validateSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new Error("A slug must contain 1–80 lowercase letters, numbers, or hyphens.");
  }
}

function countNodes(nodes: WorkflowNode[]): number {
  return nodes.reduce(
    (count, node) =>
      count + 1 + (node.kind === "condition" ? countNodes(node.then) + countNodes(node.else) : 0),
    0,
  );
}

export class Registry {
  readonly directory: string;

  constructor(readonly home = defaultHome()) {
    this.directory = join(home, "workflows");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private file(slug: string): string {
    validateSlug(slug);
    return join(this.directory, `${slug}.json`);
  }

  get(slug: string): SavedWorkflow {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.file(slug), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`No saved loopy '${slug}'. Use loopy save <file.ts> first.`);
      throw error;
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("workflow" in value) ||
      !("source" in value) ||
      typeof value.source !== "string" ||
      !("updatedAt" in value) ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error(`Invalid saved loopy '${slug}'.`);
    }
    validateWorkflow(value.workflow);
    if (value.workflow.slug !== slug) throw new Error(`Saved loopy slug does not match '${slug}'.`);
    return { workflow: value.workflow, source: value.source, updatedAt: value.updatedAt };
  }

  list(): WorkflowSummary[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const { workflow, updatedAt } = this.get(name.slice(0, -5));
        return {
          slug: workflow.slug,
          description: workflow.description,
          nodeCount: countNodes(workflow.nodes),
          updatedAt,
        };
      });
  }

  save(workflow: Workflow, source: string): SavedWorkflow {
    validateWorkflow(workflow);
    const file = this.file(workflow.slug);
    const saved = { workflow, source: resolve(source), updatedAt: new Date().toISOString() };
    const temporary = join(dirname(file), `.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    return saved;
  }

  async saveFile(file: string): Promise<SavedWorkflow> {
    const source = resolve(file);
    const module = (await import(`${pathToFileURL(source).href}?loopy=${crypto.randomUUID()}`)) as {
      default?: Parameters<typeof compileWorkflow>[0];
    };
    if (!module.default)
      throw new Error("A loopy file must default-export a workflow built with trigger(...).");
    return this.save(compileWorkflow(module.default), source);
  }
}
