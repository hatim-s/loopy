import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workflow, WorkflowSummary } from "../../core/index.js";
import {
  compileWorkflow,
  setOwnProperty,
  validateEnvironmentName,
  validateSecretBindings,
  validateSecretName,
  validateSlug,
  validateWorkflow,
} from "../../core/index.js";
import { canonicalPath, errnoCode, withLockDirectory, writeFileAtomically } from "../fs.js";
import type { SavedWorkflow, SaveOptions } from "./saved-workflow.js";
import { countNodes, isSavedFile } from "./saved-workflow.js";

export type Loaded = { workflow: Workflow; source: string };

/** Saved graphs live in `<home>/workflows/<slug>.json`, one owner source per slug. */
export class ScopedRegistry {
  readonly directory: string;

  constructor(readonly home: string) {
    this.directory = join(home, "workflows");
  }

  private file(slug: string): string {
    // Slugs reach this from HTTP paths, so keep them from escaping the directory.
    validateSlug(slug);
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
      if (errnoCode(error) === "ENOENT") {
        throw new Error(`No saved loopy '${slug}'. Use loopy save <file.ts> first.`);
      }
      throw error;
    }
    if (!isSavedFile(value)) {
      throw new Error(`Saved loopy '${slug}' is not a valid registry file.`);
    }
    validateWorkflow(value.workflow);
    if (value.workflow.slug !== slug) {
      throw new Error(`Saved loopy slug does not match '${slug}'.`);
    }
    if (value.secretBindings !== undefined) {
      validateSecretBindings(value.secretBindings);
    }
    return {
      workflow: value.workflow,
      source: value.source,
      updatedAt: value.updatedAt,
      ...(value.secretBindings === undefined ? {} : { secretBindings: value.secretBindings }),
    };
  }

  list(): WorkflowSummary[] {
    if (!existsSync(this.directory)) {
      return [];
    }
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
    if (options.replace || !existsSync(this.file(slug))) {
      return;
    }
    const existing = this.get(slug).source;
    if (existing !== source) {
      throw new Error(
        `Slug '${slug}' belongs to '${existing}'. Rename the workflow slug or use --replace to transfer it to '${source}'.`,
      );
    }
  }

  private locked<T>(slug: string, work: (file: string) => T): T {
    const file = this.file(slug);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return withLockDirectory(`${file}.lock`, "save", () => work(file));
  }

  private write(file: string, saved: SavedWorkflow): SavedWorkflow {
    writeFileAtomically(file, `${JSON.stringify(saved, null, 2)}\n`, 0o600);
    return saved;
  }

  /** Same-source saves retain grants; transferring ownership clears them under the slug lock. */
  save(workflow: Workflow, source: string, options: SaveOptions = {}): SavedWorkflow {
    validateWorkflow(workflow);
    const owner = canonicalPath(source);
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

  bindSecret(slug: string, environment: string, name: string): SavedWorkflow {
    validateEnvironmentName(environment);
    validateSecretName(name);
    return this.updateBindings(slug, (env) => setOwnProperty(env, environment, name));
  }

  unbindSecret(slug: string, environment: string): SavedWorkflow {
    validateEnvironmentName(environment);
    return this.updateBindings(slug, (env) => {
      delete env[environment];
    });
  }

  private updateBindings(
    slug: string,
    change: (env: Record<string, string>) => void,
  ): SavedWorkflow {
    return this.locked(slug, (file) => {
      const saved = this.get(slug);
      const env = { ...saved.secretBindings?.env };
      change(env);
      saved.secretBindings = { ownerId: saved.secretBindings?.ownerId ?? crypto.randomUUID(), env };
      saved.updatedAt = new Date().toISOString();
      return this.write(file, saved);
    });
  }

  /** Imports trusted TypeScript. The cache-busting query lets one process reload edits. */
  async load(file: string): Promise<Loaded> {
    const source = realpathSync(resolve(file));
    const module: { default?: unknown } = await import(
      `${pathToFileURL(source).href}?loopy=${crypto.randomUUID()}`
    );
    if (!module.default) {
      throw new Error("A loopy file must default-export a workflow built with trigger(...).");
    }
    return { workflow: compileWorkflow(module.default), source };
  }

  removeOwned(slug: string, source: string): void {
    const file = this.file(slug);
    const owner = canonicalPath(source);
    if (!existsSync(file) || this.get(slug).source !== owner) {
      return;
    }
    withLockDirectory(`${file}.lock`, "save", () => {
      if (this.get(slug).source === owner) {
        rmSync(file);
      }
    });
  }
}
