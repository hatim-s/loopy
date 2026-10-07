import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Workflow, WorkflowSummary } from "../../core/index.js";
import { compileWorkflow } from "../../core/index.js";
import { canonicalPath } from "../fs.js";
import { defaultHome } from "../home.js";
import type { SavedWorkflow, SaveOptions } from "./saved-workflow.js";
import type { Loaded } from "./scoped-registry.js";
import { ScopedRegistry } from "./scoped-registry.js";
import { snapshotPaths } from "./snapshot-paths.js";
import { findWorkflowFiles, projectRoot } from "./workflow-files.js";

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
    if (this.local.has(slug)) {
      return this.local.get(slug);
    }
    const saved = this.global.get(slug);
    if (saved.workflow.config?.scope !== "global") {
      throw new Error(
        `Loopy '${slug}' has no global scope. Save its source again with explicit scope.`,
      );
    }
    return saved;
  }

  /** The scope holding `slug`, after checking the slug resolves at all. */
  private scopeOf(slug: string): ScopedRegistry {
    this.get(slug);
    return this.local.has(slug) ? this.local : this.global;
  }

  bindSecret(slug: string, environment: string, name: string): SavedWorkflow {
    return this.scopeOf(slug).bindSecret(slug, environment, name);
  }

  unbindSecret(slug: string, environment: string): SavedWorkflow {
    return this.scopeOf(slug).unbindSecret(slug, environment);
  }

  list(): WorkflowSummary[] {
    const workflows = new Map(
      this.global
        .list()
        .filter((item) => item.scope === "global")
        .map((item) => [item.slug, item]),
    );
    for (const item of this.local.list()) {
      workflows.set(item.slug, item);
    }
    return [...workflows.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private store(workflow: Workflow): ScopedRegistry {
    return workflow.config?.scope === "global" ? this.global : this.local;
  }

  save(workflow: Workflow, source: string, options: SaveOptions = {}): SavedWorkflow {
    const snapshot = snapshotPaths(compileWorkflow(workflow), canonicalPath(source));
    const store = this.store(snapshot);
    const saved = store.save(snapshot, source, options);
    const other = store === this.global ? this.local : this.global;
    other.removeOwned(workflow.slug, source);
    if (store === this.global) {
      const sourceProject = projectRoot(dirname(canonicalPath(source)));
      if (sourceProject !== this.project) {
        new ScopedRegistry(join(sourceProject, ".loopy")).removeOwned(workflow.slug, source);
      }
    }
    return saved;
  }

  async saveFile(file: string, options: SaveOptions = {}): Promise<SavedWorkflow> {
    const { workflow, source } = await this.global.load(file);
    return this.save(workflow, source, options);
  }

  async saveDirectory(directory: string, options: SaveOptions = {}): Promise<SavedWorkflow[]> {
    const root = realpathSync(resolve(directory));
    if (!statSync(root).isDirectory()) {
      throw new Error(`'${root}' is not a directory.`);
    }
    const files = findWorkflowFiles(root);
    if (!files.length) {
      throw new Error(`No *.loopy.ts files found in '${root}'.`);
    }
    const loaded: Loaded[] = [];
    const seen = new Map<string, string>();
    for (const file of files) {
      const item = await this.global.load(file);
      const previous = seen.get(item.workflow.slug);
      if (previous) {
        throw new Error(
          `Duplicate slug '${item.workflow.slug}' in '${previous}' and '${item.source}'.`,
        );
      }
      seen.set(item.workflow.slug, item.source);
      item.workflow = snapshotPaths(item.workflow, item.source);
      loaded.push(item);
    }
    for (const { workflow, source } of loaded) {
      this.store(workflow).assertOwner(workflow.slug, source, options);
    }
    return loaded.map(({ workflow, source }) => this.save(workflow, source, options));
  }
}
