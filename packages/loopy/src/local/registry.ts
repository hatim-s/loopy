import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workflow, WorkflowNode } from "../core/model.js";
import { compileWorkflow, validateWorkflow } from "../core/workflow.js";

export const defaultHome = () => resolve(process.env.LOOPY_HOME ?? join(homedir(), ".loopy", "v2"));

export type SavedWorkflow = { workflow: Workflow; source: string; updatedAt: string };
export type WorkflowSummary = {
  slug: string;
  description?: string;
  nodeCount: number;
  updatedAt: string;
  source: string;
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
        const { workflow, updatedAt, source } = this.get(name.slice(0, -5));
        return {
          slug: workflow.slug,
          description: workflow.description,
          nodeCount: countNodes(workflow.nodes),
          updatedAt,
          source,
        };
      });
  }

  save(workflow: Workflow, source: string, options: { replace?: boolean } = {}): SavedWorkflow {
    validateWorkflow(workflow);
    const file = this.file(workflow.slug);
    const canonicalSource = (path: string) =>
      existsSync(path) ? realpathSync(path) : resolve(path);
    const owner = canonicalSource(source);
    const lock = `${file}.lock`;
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `Another save holds '${lock}'. If its process stopped, remove that lock directory and retry.`,
        );
      throw error;
    }
    const temporary = join(dirname(file), `.${crypto.randomUUID()}.tmp`);
    try {
      if (existsSync(file)) {
        const existing = this.get(workflow.slug);
        if (existing.source !== owner && !options.replace)
          throw new Error(
            `Slug '${workflow.slug}' belongs to '${existing.source}'. Rename the workflow slug or use --replace to transfer it to '${owner}'.`,
          );
      }
      const saved = { workflow, source: owner, updatedAt: new Date().toISOString() };
      writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
      chmodSync(file, 0o600);
      return saved;
    } finally {
      rmSync(temporary, { force: true });
      rmSync(lock, { recursive: true });
    }
  }

  private async loadFile(file: string): Promise<{ workflow: Workflow; source: string }> {
    const source = realpathSync(resolve(file));
    const module = (await import(`${pathToFileURL(source).href}?loopy=${crypto.randomUUID()}`)) as {
      default?: Parameters<typeof compileWorkflow>[0];
    };
    if (!module.default)
      throw new Error("A loopy file must default-export a workflow built with trigger(...).");
    const workflow = compileWorkflow(module.default);
    validateSlug(workflow.slug);
    return { workflow, source };
  }

  async saveFile(file: string, options: { replace?: boolean } = {}): Promise<SavedWorkflow> {
    const { workflow, source } = await this.loadFile(file);
    return this.save(workflow, source, options);
  }

  async saveDirectory(
    directory: string,
    options: { replace?: boolean } = {},
  ): Promise<SavedWorkflow[]> {
    const root = realpathSync(resolve(directory));
    if (!statSync(root).isDirectory()) throw new Error(`Not a directory: '${root}'.`);
    const files: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.name.startsWith(".") || ["node_modules", "dist", "coverage"].includes(entry.name))
          continue;
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile() && entry.name.endsWith(".loopy.ts")) files.push(child);
      }
    };
    walk(root);
    if (!files.length) throw new Error(`No *.loopy.ts files in '${root}'.`);
    const loaded: { workflow: Workflow; source: string }[] = [];
    const sources = new Map<string, string>();
    for (const file of files) {
      const item = await this.loadFile(file);
      const previous = sources.get(item.workflow.slug);
      if (previous)
        throw new Error(
          `Duplicate slug '${item.workflow.slug}' in '${previous}' and '${item.source}'.`,
        );
      sources.set(item.workflow.slug, item.source);
      loaded.push(item);
    }
    // Check the entire folder before writing. Each save rechecks ownership under its slug lock.
    for (const { workflow, source } of loaded) {
      if (existsSync(this.file(workflow.slug))) {
        const existing = this.get(workflow.slug);
        if (existing.source !== source && !options.replace)
          throw new Error(
            `Slug '${workflow.slug}' belongs to '${existing.source}'. Use --replace or rename it.`,
          );
      }
    }
    return loaded.map(({ workflow, source }) => this.save(workflow, source, options));
  }
}
