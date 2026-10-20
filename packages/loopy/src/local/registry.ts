import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Graph, graphSchema, type PutLoopyBody } from "../contract/index.js";
import { canonicalJson, isRecord, validateSlug } from "../core/index.js";
import { canonicalPath, withLockDirectory, writeFileAtomically } from "./fs.js";
import { parseSavedLoopy, type SavedLoopy } from "./saved-loopy.js";

function readEntry(file: string) {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));

  if (isRecord(value) && "version" in value && value.version === 2) {
    return parseSavedLoopy(value);
  }

  return null;
}

function sameSave(previous: SavedLoopy, body: PutLoopyBody) {
  return (
    previous.source === canonicalPath(body.source.path) &&
    previous.revision === body.revision &&
    canonicalJson(previous.graph.meta) === canonicalJson(body.graph.meta)
  );
}

export class Registry {
  readonly project: string;
  readonly projectDirectory: string;
  readonly globalDirectory: string;

  constructor(
    readonly home: string,
    cwd: string,
  ) {
    this.project = projectRoot(cwd);
    this.projectDirectory = join(this.project, ".loopy", "loopies");
    this.globalDirectory = join(home, "loopies");
  }

  private files(slug: string) {
    validateSlug(slug);

    return [this.projectDirectory, this.globalDirectory].map((directory) =>
      join(directory, `${slug}.json`),
    );
  }

  get(slug: string): SavedLoopy {
    for (const file of this.files(slug)) {
      if (!existsSync(file)) {
        continue;
      }

      const entry = readEntry(file);

      if (entry) {
        return entry;
      }
    }

    throw new Error(`No saved loopy '${slug}'. Use loopy save <file.ts> first.`);
  }

  list(): SavedLoopy[] {
    const entries = new Map<string, SavedLoopy>();

    for (const directory of [this.globalDirectory, this.projectDirectory]) {
      if (!existsSync(directory)) {
        continue;
      }

      for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        const entry = readEntry(join(directory, file));

        if (entry) {
          entries.set(entry.slug, entry);
        }
      }
    }

    return [...entries.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  unchanged(body: PutLoopyBody) {
    const files = this.files(body.graph.name);
    const file = body.graph.meta.scope === "project" ? files[0] : files[1];
    const previous = file && existsSync(file) ? readEntry(file) : null;

    return previous && sameSave(previous, body)
      ? { ok: true as const, entry: previous }
      : { ok: false as const };
  }

  save(body: PutLoopyBody): SavedLoopy {
    const { graph, revision, source, replace, bundles } = body;
    const meta = graph.meta;
    const owner = canonicalPath(source.path);
    const files = this.files(graph.name);
    const directory = meta.scope === "project" ? this.projectDirectory : this.globalDirectory;
    const file = join(directory, `${graph.name}.json`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

    return withLockDirectory(`${file}.lock`, "save", () => {
      const previous = existsSync(file) ? readEntry(file) : null;

      if (previous && previous.source !== owner && !replace) {
        throw new Error(
          `Slug '${graph.name}' belongs to another source. Rename it or use --replace.`,
        );
      }

      if (previous && sameSave(previous, body)) {
        return previous;
      }

      const entry: SavedLoopy = {
        version: 2,
        slug: graph.name,
        scope: meta.scope,
        graph,
        revision,
        bundles: bundles.map(({ nodeId, bundleHash }) => ({ nodeId, bundleHash })),
        source: owner,
        description: meta.description,
        input: graph.input,
        schedule: meta.schedule,
        mode: meta.mode,
        secrets: meta.secrets,
        savedAt: new Date().toISOString(),
      };

      writeFileAtomically(file, `${JSON.stringify(entry, null, 2)}\n`, 0o600);

      for (const other of files.filter((candidate) => candidate !== file)) {
        if (existsSync(other) && readEntry(other)?.source === owner) {
          rmSync(other);
        }
      }

      return entry;
    });
  }

  private artifactPath(directory: string, hash: string, extension: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Invalid artifact hash. Save the loopy again.");
    }

    return join(this.home, directory, `${hash}.${extension}`);
  }

  bundlePath(hash: string): string {
    return this.artifactPath("bundles", hash, "js");
  }

  graphPath(revision: string): string {
    return this.artifactPath("graphs", revision, "json");
  }

  /** Reads the graph one revision pinned, which later saves never overwrite. */
  async revisionGraph(revision: string): Promise<Graph> {
    return graphSchema.parse(JSON.parse(await readFile(this.graphPath(revision), "utf8")));
  }
}

export function projectRoot(cwd: string): string {
  let directory = canonicalPath(cwd);

  while (true) {
    if (existsSync(join(directory, ".loopy", "loopies"))) {
      return directory;
    }

    const parent = dirname(directory);

    if (parent === directory) {
      return canonicalPath(cwd);
    }

    directory = parent;
  }
}
