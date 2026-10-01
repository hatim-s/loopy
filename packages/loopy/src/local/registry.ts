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
type Loaded = { workflow: Workflow; source: string };
type SaveOptions = { replace?: boolean };

const SKIPPED_DIRECTORIES = ["node_modules", "dist", "coverage"];

function countNodes(nodes: WorkflowNode[]): number {
  return nodes.reduce(
    (count, node) =>
      count + 1 + (node.kind === "condition" ? countNodes(node.then) + countNodes(node.else) : 0),
    0,
  );
}

/** Canonical path for ownership checks: symlinks resolve, missing files stay absolute. */
function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isSavedFile(
  value: unknown,
): value is { workflow: unknown; source: string; updatedAt: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.source === "string" && typeof record.updatedAt === "string";
}

/** Saved graphs live in `<home>/workflows/<slug>.json`, one owner source per slug. */
export class Registry {
  readonly directory: string;

  constructor(readonly home = defaultHome()) {
    this.directory = join(home, "workflows");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private file(slug: string): string {
    // Slugs reach this from HTTP paths, so keep them from escaping the directory.
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug))
      throw new Error("A slug must contain 1-80 lowercase letters, numbers, or hyphens.");
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
    if (!isSavedFile(value)) throw new Error(`Invalid saved loopy '${slug}'.`);
    validateWorkflow(value.workflow);
    if (value.workflow.slug !== slug) throw new Error(`Saved loopy slug does not match '${slug}'.`);
    return { workflow: value.workflow, source: value.source, updatedAt: value.updatedAt };
  }

  list(): WorkflowSummary[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const { workflow, updatedAt, source } = this.get(name.slice(0, -".json".length));
        return {
          slug: workflow.slug,
          description: workflow.description,
          nodeCount: countNodes(workflow.nodes),
          updatedAt,
          source,
        };
      });
  }

  private assertOwner(slug: string, source: string, options: SaveOptions): void {
    if (options.replace || !existsSync(this.file(slug))) return;
    const existing = this.get(slug).source;
    if (existing !== source)
      throw new Error(
        `Slug '${slug}' belongs to '${existing}'. Rename the workflow slug or use --replace to transfer it to '${source}'.`,
      );
  }

  /** Writes under a per-slug lock directory, then renames into place. */
  save(workflow: Workflow, source: string, options: SaveOptions = {}): SavedWorkflow {
    validateWorkflow(workflow);
    const file = this.file(workflow.slug);
    const owner = canonical(source);
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
      this.assertOwner(workflow.slug, owner, options);
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

  /** Imports trusted TypeScript. The cache-busting query lets one process reload edits. */
  private async load(file: string): Promise<Loaded> {
    const source = realpathSync(resolve(file));
    const module = (await import(`${pathToFileURL(source).href}?loopy=${crypto.randomUUID()}`)) as {
      default?: Parameters<typeof compileWorkflow>[0];
    };
    if (!module.default)
      throw new Error("A loopy file must default-export a workflow built with trigger(...).");
    return { workflow: compileWorkflow(module.default), source };
  }

  async saveFile(file: string, options: SaveOptions = {}): Promise<SavedWorkflow> {
    const { workflow, source } = await this.load(file);
    return this.save(workflow, source, options);
  }

  /** Loads every `*.loopy.ts` under a folder and checks all of them before writing any. */
  async saveDirectory(directory: string, options: SaveOptions = {}): Promise<SavedWorkflow[]> {
    const root = realpathSync(resolve(directory));
    if (!statSync(root).isDirectory()) throw new Error(`Not a directory: '${root}'.`);
    const files = findWorkflowFiles(root);
    if (!files.length) throw new Error(`No *.loopy.ts files in '${root}'.`);
    const loaded: Loaded[] = [];
    const seen = new Map<string, string>();
    for (const file of files) {
      const item = await this.load(file);
      const previous = seen.get(item.workflow.slug);
      if (previous)
        throw new Error(
          `Duplicate slug '${item.workflow.slug}' in '${previous}' and '${item.source}'.`,
        );
      seen.set(item.workflow.slug, item.source);
      loaded.push(item);
    }
    for (const { workflow, source } of loaded) this.assertOwner(workflow.slug, source, options);
    return loaded.map(({ workflow, source }) => this.save(workflow, source, options));
  }
}

function findWorkflowFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (path: string) => {
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".loopy.ts")) files.push(child);
    }
  };
  walk(root);
  return files;
}
