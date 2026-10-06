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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SecretBindings, Workflow, WorkflowNode } from "../core/model.js";
import {
  validateEnvironmentName,
  validateSecretBindings,
  validateSecretName,
} from "../core/secret-bindings.js";
import { compileWorkflow, validateWorkflow } from "../core/workflow.js";

export const defaultHome = () => resolve(process.env.LOOPY_HOME ?? join(homedir(), ".loopy", "v2"));

export type SavedWorkflow = {
  workflow: Workflow;
  source: string;
  updatedAt: string;
  secretBindings?: SecretBindings;
};
export type WorkflowSummary = {
  slug: string;
  description?: string;
  scope: "project" | "global";
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
): value is { workflow: unknown; source: string; updatedAt: string; secretBindings?: unknown } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.source === "string" && typeof record.updatedAt === "string";
}

/** Saved graphs live in `<home>/workflows/<slug>.json`, one owner source per slug. */
class ScopedRegistry {
  readonly directory: string;

  constructor(readonly home: string) {
    this.directory = join(home, "workflows");
  }

  private file(slug: string): string {
    // Slugs reach this from HTTP paths, so keep them from escaping the directory.
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug))
      throw new Error("A slug must contain 1-80 lowercase letters, numbers, or hyphens.");
    return join(this.directory, `${slug}.json`);
  }

  has(slug: string): boolean {
    return existsSync(this.file(slug));
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
    if (value.secretBindings !== undefined) validateSecretBindings(value.secretBindings);
    return {
      workflow: value.workflow,
      source: value.source,
      updatedAt: value.updatedAt,
      ...(value.secretBindings === undefined ? {} : { secretBindings: value.secretBindings }),
    };
  }

  list(): WorkflowSummary[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const { workflow, updatedAt, source } = this.get(name.slice(0, -".json".length));
        return {
          slug: workflow.slug,
          description: workflow.description,
          scope: workflow.config?.scope ?? "project",
          nodeCount: countNodes(workflow.nodes),
          updatedAt,
          source,
        };
      });
  }

  assertOwner(slug: string, source: string, options: SaveOptions): void {
    if (options.replace || !existsSync(this.file(slug))) return;
    const existing = this.get(slug).source;
    if (existing !== source)
      throw new Error(
        `Slug '${slug}' belongs to '${existing}'. Rename the workflow slug or use --replace to transfer it to '${source}'.`,
      );
  }

  private locked<T>(slug: string, work: (file: string) => T): T {
    const file = this.file(slug);
    const lock = `${file}.lock`;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `Another save holds '${lock}'. If its process stopped, remove that lock directory and retry.`,
        );
      throw error;
    }
    try {
      return work(file);
    } finally {
      rmSync(lock, { recursive: true });
    }
  }

  private write(file: string, saved: SavedWorkflow): SavedWorkflow {
    const temporary = join(dirname(file), `.${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
      chmodSync(file, 0o600);
      return saved;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Same-source saves retain grants; transferring ownership clears them under the slug lock. */
  save(workflow: Workflow, source: string, options: SaveOptions = {}): SavedWorkflow {
    validateWorkflow(workflow);
    const owner = canonical(source);
    return this.locked(workflow.slug, (file) => {
      this.assertOwner(workflow.slug, owner, options);
      const previous = existsSync(file) ? this.get(workflow.slug) : undefined;
      const secretBindings = previous?.source === owner ? previous.secretBindings : undefined;
      return this.write(file, {
        workflow,
        source: owner,
        updatedAt: new Date().toISOString(),
        ...(secretBindings === undefined ? {} : { secretBindings }),
      });
    });
  }

  bindSecret(slug: string, environment: string, name?: string): SavedWorkflow {
    validateEnvironmentName(environment);
    if (name !== undefined) validateSecretName(name);
    return this.locked(slug, (file) => {
      const saved = this.get(slug);
      const env = { ...saved.secretBindings?.env };
      if (name === undefined) delete env[environment];
      else
        Object.defineProperty(env, environment, {
          value: name,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      saved.secretBindings = { ownerId: saved.secretBindings?.ownerId ?? crypto.randomUUID(), env };
      saved.updatedAt = new Date().toISOString();
      return this.write(file, saved);
    });
  }

  /** Imports trusted TypeScript. The cache-busting query lets one process reload edits. */
  async load(file: string): Promise<Loaded> {
    const source = realpathSync(resolve(file));
    const module = (await import(`${pathToFileURL(source).href}?loopy=${crypto.randomUUID()}`)) as {
      default?: Parameters<typeof compileWorkflow>[0];
    };
    if (!module.default)
      throw new Error("A loopy file must default-export a workflow built with trigger(...).");
    return { workflow: compileWorkflow(module.default), source };
  }

  removeOwned(slug: string, source: string): void {
    const file = this.file(slug);
    if (!existsSync(file) || this.get(slug).source !== canonical(source)) return;
    const lock = `${file}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    try {
      if (this.get(slug).source === canonical(source)) rmSync(file);
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
}

function projectRoot(cwd: string): string {
  let directory = canonical(cwd);
  while (true) {
    if (existsSync(join(directory, ".loopy", "workflows"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return canonical(cwd);
    directory = parent;
  }
}

/** Project definitions override global definitions with the same slug. */
export class Registry {
  readonly project: string;
  readonly directory: string;
  private readonly global: ScopedRegistry;
  private readonly local: ScopedRegistry;

  constructor(
    readonly home = defaultHome(),
    cwd = process.cwd(),
  ) {
    this.project = projectRoot(cwd);
    this.global = new ScopedRegistry(home);
    this.local = new ScopedRegistry(join(this.project, ".loopy"));
    this.directory = this.local.directory;
  }

  get(slug: string): SavedWorkflow {
    if (this.local.has(slug)) return this.local.get(slug);
    const saved = this.global.get(slug);
    if (saved.workflow.config?.scope !== "global")
      throw new Error(
        `Loopy '${slug}' has no global scope. Save its source again with explicit scope.`,
      );
    return saved;
  }

  bindSecret(slug: string, environment: string, name: string): SavedWorkflow {
    const store = this.local.has(slug) ? this.local : this.global;
    this.get(slug);
    return store.bindSecret(slug, environment, name);
  }

  unbindSecret(slug: string, environment: string): SavedWorkflow {
    const store = this.local.has(slug) ? this.local : this.global;
    this.get(slug);
    return store.bindSecret(slug, environment);
  }

  list(): WorkflowSummary[] {
    const workflows = new Map(
      this.global
        .list()
        .filter((item) => item.scope === "global")
        .map((item) => [item.slug, item]),
    );
    for (const item of this.local.list()) workflows.set(item.slug, item);
    return [...workflows.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private store(workflow: Workflow): ScopedRegistry {
    return workflow.config?.scope === "global" ? this.global : this.local;
  }

  save(workflow: Workflow, source: string, options: SaveOptions = {}): SavedWorkflow {
    const snapshot = snapshotPaths(compileWorkflow(workflow), canonical(source));
    const store = this.store(snapshot);
    const saved = store.save(snapshot, source, options);
    const other = store === this.global ? this.local : this.global;
    other.removeOwned(workflow.slug, source);
    if (store === this.global) {
      const sourceProject = projectRoot(dirname(canonical(source)));
      if (sourceProject !== this.project)
        new ScopedRegistry(join(sourceProject, ".loopy")).removeOwned(workflow.slug, source);
    }
    return saved;
  }

  async saveFile(file: string, options: SaveOptions = {}): Promise<SavedWorkflow> {
    const { workflow, source } = await this.global.load(file);
    return this.save(workflow, source, options);
  }

  async saveDirectory(directory: string, options: SaveOptions = {}): Promise<SavedWorkflow[]> {
    const root = realpathSync(resolve(directory));
    if (!statSync(root).isDirectory()) throw new Error(`Not a directory: '${root}'.`);
    const files = findWorkflowFiles(root);
    if (!files.length) throw new Error(`No *.loopy.ts files in '${root}'.`);
    const loaded: Loaded[] = [];
    const seen = new Map<string, string>();
    for (const file of files) {
      const item = await this.global.load(file);
      const previous = seen.get(item.workflow.slug);
      if (previous)
        throw new Error(
          `Duplicate slug '${item.workflow.slug}' in '${previous}' and '${item.source}'.`,
        );
      seen.set(item.workflow.slug, item.source);
      item.workflow = snapshotPaths(item.workflow, item.source);
      loaded.push(item);
    }
    for (const { workflow, source } of loaded)
      this.store(workflow).assertOwner(workflow.slug, source, options);
    return loaded.map(({ workflow, source }) => this.save(workflow, source, options));
  }
}

function snapshotPaths(workflow: Workflow, source: string): Workflow {
  const global = workflow.config?.scope === "global";
  const base = dirname(source);
  const explicitRelative = (path: string) => path.startsWith("./") || path.startsWith("../");
  const value = (item: unknown, cwd: string): unknown => {
    if (typeof item === "string")
      return global && explicitRelative(item) ? resolve(cwd, item) : item;
    if (!item || typeof item !== "object") return item;
    if ("$file" in item) {
      const path = (item as { $file: string }).$file;
      return global ? resolve(cwd, path) : path;
    }
    if ("$op" in item) {
      const expression = item as { $op: string; args: unknown[] };
      // Only marked paths are rewritten inside expressions; string fragments may be prose.
      return {
        ...expression,
        args: expression.args.map((part) => (typeof part === "string" ? part : value(part, cwd))),
      };
    }
    return item;
  };
  const walk = (nodes: WorkflowNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "condition") {
        node.test = value(node.test, base) as typeof node.test;
        walk(node.then);
        walk(node.else);
        continue;
      }
      const command = node.command;
      const cwd = resolve(base, command.cwd ?? ".");
      if (global) {
        if (command.cwd !== undefined) command.cwd = cwd;
        if (isAbsolute(command.program) || command.program.includes("/"))
          command.program = resolve(cwd, command.program);
      }
      command.args = command.args.map((arg) => value(arg, cwd)) as typeof command.args;
      if (command.stdin !== undefined)
        command.stdin = value(command.stdin, cwd) as typeof command.stdin;
      if (command.env)
        command.env = Object.fromEntries(
          Object.entries(command.env).map(([key, item]) => [key, value(item, cwd)]),
        ) as typeof command.env;
    }
  };
  walk(workflow.nodes);
  validateWorkflow(workflow);
  return workflow;
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
