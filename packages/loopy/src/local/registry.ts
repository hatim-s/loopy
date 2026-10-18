import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  graphSchema,
  hashSchema,
  type PutLoopyBody,
  type SavedLoopy,
  savedLoopySchema,
} from "../contract/index.js";
import {
  bundleRefs,
  canonicalJson,
  type Graph,
  revision,
  sha256Hex,
  validateGraph,
} from "../core/index.js";
import { writeFileAtomically } from "../executor/index.js";
import { canonicalPath, withLockDirectory } from "./fs.js";
import { homePaths } from "./home.js";
import { ServiceError } from "./service-error.js";

function readEntry(file: string) {
  return savedLoopySchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function cleanEntries(directory: string) {
  if (!existsSync(directory)) {
    return;
  }

  for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    const file = join(directory, name);
    const contents = readFileSync(file, "utf8");
    let value: unknown;

    try {
      value = JSON.parse(contents);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      rmSync(file);
      continue;
    }

    if (!savedLoopySchema.safeParse(value).success) {
      rmSync(file);
    }
  }
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
    this.globalDirectory = homePaths(home).loopies;
    cleanEntries(this.projectDirectory);
    cleanEntries(this.globalDirectory);
  }

  private entryFile(slug: string, scope: Graph["meta"]["scope"]) {
    return join(scope === "project" ? this.projectDirectory : this.globalDirectory, `${slug}.json`);
  }

  get(slug: string): SavedLoopy | null {
    for (const scope of ["project", "global"] as const) {
      const file = this.entryFile(slug, scope);

      if (existsSync(file)) {
        return readEntry(file);
      }
    }

    return null;
  }

  list(): SavedLoopy[] {
    const entries = new Map<string, SavedLoopy>();

    for (const directory of [this.globalDirectory, this.projectDirectory]) {
      if (!existsSync(directory)) {
        continue;
      }

      for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        const entry = readEntry(join(directory, file));
        entries.set(entry.graph.name, entry);
      }
    }

    return [...entries.values()].sort((a, b) => a.graph.name.localeCompare(b.graph.name));
  }

  async save(body: PutLoopyBody): Promise<SavedLoopy> {
    const { graph, source, replace } = body;
    const diagnostics = validateGraph(graph);

    if (diagnostics.length > 0) {
      throw new ServiceError("bad_request", diagnostics.map((item) => item.message).join("\n"));
    }

    const expected = bundleRefs(graph);

    if (expected.length !== body.bundles.length) {
      throw new ServiceError(
        "bad_request",
        "Supply exactly one bundle for each code node and parser in node order.",
      );
    }

    if ((await revision(graph)) !== body.revision) {
      throw new ServiceError("bad_request", "The graph revision does not match its contents.");
    }

    const bundles = await Promise.all(
      body.bundles.map(async (encoded) => {
        const bytes = Buffer.from(encoded, "base64");

        return { bytes, bundleHash: await sha256Hex(bytes) };
      }),
    );

    if (bundles.some((bundle, index) => bundle.bundleHash !== expected[index]?.bundleHash)) {
      throw new ServiceError("bad_request", "Bundle bytes do not match their hash.");
    }

    await this.writeArtifacts(bundles, body.revision, graph);
    const owner = canonicalPath(source.path);
    const file = this.entryFile(graph.name, graph.meta.scope);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

    return withLockDirectory(`${file}.lock`, "save", async () => {
      const previous = existsSync(file) ? readEntry(file) : null;

      if (previous && previous.source !== owner && !replace) {
        throw new ServiceError(
          "source_conflict",
          `Slug '${graph.name}' belongs to another source. Rename it or use --replace.`,
        );
      }

      if (previous && previous.source === owner && previous.revision === body.revision) {
        return previous;
      }

      const entry: SavedLoopy = {
        version: 2,
        revision: body.revision,
        source: owner,
        graph,
        savedAt: new Date().toISOString(),
      };

      await writeFileAtomically(file, `${JSON.stringify(entry, null, 2)}\n`, {
        mode: 0o600,
        syncDirectory: true,
      });

      const other = this.entryFile(
        graph.name,
        graph.meta.scope === "project" ? "global" : "project",
      );

      if (existsSync(other) && readEntry(other).source === owner) {
        rmSync(other);
      }

      return entry;
    });
  }

  async readGraph(revision: string) {
    return graphSchema.parse(await Bun.file(this.graphPath(revision)).json());
  }

  async writeArtifacts(
    bundles: readonly { bundleHash: string; bytes: Uint8Array }[],
    revision: string,
    graph: Graph,
  ) {
    for (const directory of ["bundles", "graphs"] as const) {
      mkdirSync(homePaths(this.home)[directory], { recursive: true, mode: 0o700 });
    }

    for (const bundle of bundles) {
      const file = this.bundlePath(bundle.bundleHash);

      if (!existsSync(file)) {
        await writeFileAtomically(file, bundle.bytes, { mode: 0o600, syncDirectory: true });
      }
    }

    const file = this.graphPath(revision);

    if (!existsSync(file)) {
      await writeFileAtomically(file, canonicalJson(graph), { mode: 0o600, syncDirectory: true });
    }
  }

  private artifactPath(directory: "bundles" | "graphs", hash: string, extension: string) {
    return join(homePaths(this.home)[directory], `${hashSchema.parse(hash)}.${extension}`);
  }

  bundlePath(hash: string) {
    return this.artifactPath("bundles", hash, "js");
  }

  private graphPath(revision: string) {
    return this.artifactPath("graphs", revision, "json");
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
