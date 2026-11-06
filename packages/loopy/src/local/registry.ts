import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Data, Effect, Schema } from "effect";
import {
  graphSchema,
  MAX_SOURCE_BYTES,
  type PutLoopyBody,
  type SavedLoopy,
  type SourceArtifact,
  savedLoopySchema,
  sourceArtifactSchema,
} from "../contract";
import { canonicalJson, isRecord, validateSlug } from "../core";
import { RegistryConflictError, RegistryError } from "../service";
import { canonicalPath, errnoCode, withLockDirectory, writeFileAtomically } from "./fs";
import { redactSourceArtifact } from "./source-view";

function readEntry(file: string) {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));

  if (isRecord(value) && "version" in value && value.version === 2) {
    const entry = Schema.decodeUnknownSync(savedLoopySchema, { onExcessProperty: "error" })(value);
    validateSlug(entry.slug);

    return entry;
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

export class RegistryMissingError extends Data.TaggedError("RegistryMissingError")<{
  slug: string;
}> {
  override get message() {
    return `No saved loopy '${this.slug}'. Use loopy save <file.ts> first.`;
  }
}

export const registrySync = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new RegistryError({ operation, cause }),
  });

const registryPromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RegistryError({ operation, cause }),
  });

export class Registry {
  readonly project: string;
  readonly projectDirectory: string;
  readonly globalDirectory: string;

  static make(home: string, cwd: string) {
    return registrySync("open registry", () => new Registry(home, projectRoot(cwd)));
  }

  private constructor(
    readonly home: string,
    project: string,
  ) {
    this.project = project;
    this.projectDirectory = join(this.project, ".loopy", "loopies");
    this.globalDirectory = join(home, "loopies");
  }

  private files(slug: string) {
    validateSlug(slug);

    return [this.projectDirectory, this.globalDirectory].map((directory) =>
      join(directory, `${slug}.json`),
    );
  }

  get(slug: string) {
    return registrySync("read definition", () => {
      for (const file of this.files(slug)) {
        if (!existsSync(file)) {
          continue;
        }

        const entry = readEntry(file);

        if (entry) {
          return entry;
        }
      }

      return null;
    }).pipe(
      Effect.flatMap((entry) =>
        entry ? Effect.succeed(entry) : Effect.fail(new RegistryMissingError({ slug })),
      ),
    );
  }

  list() {
    return registrySync("list definitions", () => {
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
    });
  }

  unchanged(body: PutLoopyBody) {
    return registrySync("compare definition", () => {
      const files = this.files(body.graph.name);
      const file = body.graph.meta.scope === "project" ? files[0] : files[1];
      const previous = file && existsSync(file) ? readEntry(file) : null;

      return previous && sameSave(previous, body)
        ? { ok: true as const, entry: previous }
        : { ok: false as const };
    });
  }

  save(body: PutLoopyBody) {
    return registrySync("publish definition", () => {
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
          return { kind: "conflict" } as const;
        }

        if (previous && sameSave(previous, body)) {
          return { kind: "saved", entry: previous } as const;
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

        if (body.sourceArtifact) {
          this.pinSourceSync(graph.name, body.sourceArtifact);
        }

        writeFileAtomically(file, `${JSON.stringify(entry, null, 2)}\n`, 0o600);

        for (const other of files.filter((candidate) => candidate !== file)) {
          if (existsSync(other) && readEntry(other)?.source === owner) {
            rmSync(other);
          }
        }

        return { kind: "saved", entry } as const;
      });
    }).pipe(
      Effect.flatMap((result) =>
        result.kind === "saved"
          ? Effect.succeed(result.entry)
          : Effect.fail(
              new RegistryConflictError({
                slug: body.graph.name,
                message: `Slug '${body.graph.name}' belongs to another source. Rename it or use --replace.`,
              }),
            ),
      ),
    );
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

  private sourcePath(slug: string, revision: string): string {
    validateSlug(slug);
    const file = this.artifactPath("sources", revision, "json");

    return join(dirname(file), slug, `${revision}.json`);
  }

  pinSource(slug: string, artifact: SourceArtifact) {
    return registrySync("pin source", () => this.pinSourceSync(slug, artifact));
  }

  private pinSourceSync(slug: string, artifact: SourceArtifact): void {
    const file = this.sourcePath(slug, artifact.revision);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    withLockDirectory(`${file}.lock`, "source capture", () => {
      if (!existsSync(file)) {
        writeFileAtomically(file, canonicalJson(artifact), 0o600);
      }
    });
  }

  revisionSource(slug: string, revision: string) {
    return Effect.gen({ self: this }, function* () {
      const file = yield* registrySync("source path", () => this.sourcePath(slug, revision));

      const info = yield* registryPromise("stat source", () => stat(file)).pipe(
        Effect.catchTag("RegistryError", (error) =>
          errnoCode(error.cause) === "ENOENT" ? Effect.succeed(null) : Effect.fail(error),
        ),
      );

      if (info === null) {
        return {
          version: 1,
          status: "unavailable",
          revision,
          reason: "not_captured",
        } satisfies SourceArtifact;
      }

      if (info.size > MAX_SOURCE_BYTES * 2) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "read source",
            cause: new Error("Source artifact exceeds the 512 KiB payload limit."),
          }),
        );
      }

      const contents = yield* registryPromise("read source", () => readFile(file, "utf8"));

      const artifact = yield* registrySync("decode source", () =>
        Schema.decodeUnknownSync(sourceArtifactSchema, { onExcessProperty: "error" })(
          JSON.parse(contents),
        ),
      );

      if (artifact.revision !== revision) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "read source",
            cause: new Error("Source artifact does not match the requested revision."),
          }),
        );
      }

      return yield* redactSourceArtifact(this.home, artifact).pipe(
        Effect.mapError((cause) => new RegistryError({ operation: "redact source", cause })),
      );
    });
  }

  /** Reads the graph one revision pinned, which later saves never overwrite. */
  revisionGraph(revision: string) {
    return Effect.gen({ self: this }, function* () {
      const file = yield* registrySync("graph path", () => this.graphPath(revision));
      const contents = yield* registryPromise("read graph", () => readFile(file, "utf8"));

      return yield* registrySync("decode graph", () =>
        Schema.decodeUnknownSync(graphSchema, { onExcessProperty: "error" })(JSON.parse(contents)),
      );
    });
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
