import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateSlug } from "../core/index.js";
import { isStandardSchema, type Loopy } from "../sdk/host.js";
import { canonicalPath, withLockDirectory, writeFileAtomically } from "./fs.js";
import { parseSavedLoopy, type SavedLoopy } from "./registry/saved-loopy.js";

function readEntry(file: string) {
  return parseSavedLoopy(JSON.parse(readFileSync(file, "utf8")));
}

export class Loopies {
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

  has(slug: string): boolean {
    return this.files(slug).some((file) => existsSync(file));
  }

  get(slug: string): SavedLoopy {
    const file = this.files(slug).find((candidate) => existsSync(candidate));

    if (!file) {
      throw new Error(`No saved loopy '${slug}'. Use loopy save <file.ts> first.`);
    }

    return readEntry(file);
  }

  list(): SavedLoopy[] {
    const entries = new Map<string, SavedLoopy>();

    for (const directory of [this.globalDirectory, this.projectDirectory]) {
      if (!existsSync(directory)) {
        continue;
      }

      for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        const entry = readEntry(join(directory, file));
        entries.set(entry.slug, entry);
      }
    }

    return [...entries.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  save(
    loopy: Loopy,
    {
      source,
      bundleHash,
      replace = false,
    }: { source: string; bundleHash: string; replace?: boolean },
  ): SavedLoopy {
    const owner = canonicalPath(source);
    const files = this.files(loopy.name);
    const directory = loopy.scope === "project" ? this.projectDirectory : this.globalDirectory;
    const file = join(directory, `${loopy.name}.json`);

    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

    return withLockDirectory(`${file}.lock`, "save", () => {
      if (existsSync(file) && readEntry(file).source !== owner && !replace) {
        throw new Error(
          `Slug '${loopy.name}' belongs to another source. Rename it or use --replace.`,
        );
      }

      const entry = savedEntry(loopy, owner, bundleHash);
      writeFileAtomically(file, `${JSON.stringify(entry, null, 2)}\n`, 0o600);

      for (const other of files.filter((candidate) => candidate !== file)) {
        if (existsSync(other) && readEntry(other).source === owner) {
          rmSync(other);
        }
      }

      return entry;
    });
  }

  bundlePath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Invalid bundle hash. Save the loopy again.");
    }

    return join(this.home, "bundles", `${hash}.js`);
  }
}

function savedEntry(loopy: Loopy, source: string, bundleHash: string): SavedLoopy {
  return {
    slug: loopy.name,
    scope: loopy.scope,
    bundleHash,
    source,
    description: loopy.description,
    input: isStandardSchema(loopy.input) ? "schema" : (loopy.input ?? {}),
    schedule: loopy.schedule,
    mode: loopy.mode,
    secrets: loopy.secrets,
    savedAt: new Date().toISOString(),
  };
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
