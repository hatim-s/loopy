import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  boundaryOptions,
  decodeJson,
  definitionSummary,
  graphSchema,
  MAX_SOURCE_JSON_BYTES,
  type PutLoopyBody,
  type SavedLoopy,
  type SourceArtifact,
  savedLoopySchema,
  sourceArtifactSchema,
  unavailableSource,
} from "@loopy/contract";
import { canonicalJson, hashSchema, validateSlug } from "@loopy/core";
import { Effect, Result, Schema } from "effect";
import { canonicalPath, readRegularFile, withLockDirectory, writeFileAtomically } from "../os";
import {
  type ArtifactRegistry,
  RegistryConflictError,
  RegistryError,
  registrySync,
} from "../service";
import { saveCompiled } from "./save-compiled";
import { redactSourceArtifact } from "./source-view";

const decodeEntry = Schema.decodeUnknownResult(
  Schema.fromJsonString(savedLoopySchema),
  boundaryOptions,
);

function readEntry(file: string) {
  const entry = decodeEntry(readFileSync(file, "utf8"));

  if (Result.isFailure(entry)) {
    throw new Error(
      `Registry entry '${file}' uses an old or invalid format. Delete it and save the loopy again.`,
    );
  }

  validateSlug(entry.success.slug);

  return entry.success;
}

const isHash = Schema.is(hashSchema);

function artifactName(hash: string, extension: string): string {
  if (!isHash(hash)) {
    throw new Error("Invalid artifact hash. Save the loopy again.");
  }

  return `${hash}.${extension}`;
}

function sameSave(previous: SavedLoopy, body: PutLoopyBody) {
  return (
    previous.source === canonicalPath(body.source.path) &&
    previous.revision === body.revision &&
    canonicalJson(previous.graph.meta) === canonicalJson(body.graph.meta)
  );
}

const registryPromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RegistryError({ operation, cause }),
  });

export class Registry implements ArtifactRegistry {
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

  private fileFor(scope: SavedLoopy["graph"]["meta"]["scope"], slug: string) {
    validateSlug(slug);

    return join(scope === "project" ? this.projectDirectory : this.globalDirectory, `${slug}.json`);
  }

  workspace() {
    return Effect.succeed(this.project);
  }

  listSummaries() {
    return this.list().pipe(Effect.map((entries) => entries.map(definitionSummary)));
  }

  /** Validates and stores the compiled artifacts, then publishes the definition. */
  save(body: PutLoopyBody) {
    return saveCompiled(this, body).pipe(Effect.asVoid);
  }

  get(slug: string) {
    return registrySync("read definition", () => {
      for (const file of this.files(slug)) {
        if (!existsSync(file)) {
          continue;
        }

        return readEntry(file);
      }

      return null;
    });
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
          entries.set(entry.slug, entry);
        }
      }

      return [...entries.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    });
  }

  unchanged(body: PutLoopyBody) {
    return registrySync("compare definition", () => {
      const file = this.fileFor(body.graph.meta.scope, body.graph.name);
      const previous = existsSync(file) ? readEntry(file) : null;

      return previous && sameSave(previous, body)
        ? { ok: true as const, entry: previous }
        : { ok: false as const };
    });
  }

  /** Publishes definition metadata. Callers store the compiled artifacts it names first. */
  publish(body: PutLoopyBody) {
    return registrySync("publish definition", () => {
      const { graph, revision, source, replace, bundles } = body;
      const owner = canonicalPath(source.path);
      const files = this.files(graph.name);
      const file = this.fileFor(graph.meta.scope, graph.name);
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
          version: 3,
          slug: graph.name,
          graph,
          revision,
          bundles: bundles.map(({ nodeId, bundleHash }) => ({ nodeId, bundleHash })),
          source: owner,
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

  bundlePath(hash: string): string {
    return join(this.home, "bundles", artifactName(hash, "js"));
  }

  graphPath(revision: string): string {
    return join(this.home, "graphs", artifactName(revision, "json"));
  }

  private sourcePath(slug: string, revision: string): string {
    validateSlug(slug);

    return join(this.home, "sources", slug, artifactName(revision, "json"));
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

      const contents = yield* registrySync("read source", () =>
        readRegularFile(file, MAX_SOURCE_JSON_BYTES),
      );

      if (contents === null) {
        return unavailableSource(revision, "not_captured");
      }

      const artifact = yield* registrySync("decode source", () =>
        decodeJson(sourceArtifactSchema)(contents.toString("utf8")),
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

      return yield* registrySync("decode graph", () => decodeJson(graphSchema)(contents));
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
