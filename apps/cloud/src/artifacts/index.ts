import type { DurableObjectStorage, R2Bucket } from "@cloudflare/workers-types";
import {
  type DefinitionSummary,
  decodeBoundary,
  decodeJson,
  definitionSummary,
  type Graph,
  graphSchema,
  type PutLoopyBody,
  type SavedLoopy,
  type SourceArtifact,
  sourceArtifactSchema,
  unavailableSource,
  validateCompiled,
} from "@loopy/contract";
import { canonicalJson, revision, validateSlug } from "@loopy/core";
import {
  type ArtifactRegistry,
  ArtifactValidationError,
  RegistryConflictError,
  RegistryError,
} from "@loopy/runtime/service";
import { Effect, Result } from "effect";
import { ArtifactDefinitions, artifactEntry, type Publication } from "./definitions";
import { ARTIFACT_LIMITS, ArtifactStorage, bytesToBase64, hashKey } from "./storage";
import { checkArtifactLimits } from "./validation";

export { ARTIFACT_LIMITS } from "./storage";

const decoder = new TextDecoder();

const publicationSync = <A>(operation: string, work: () => A) =>
  Effect.try({
    try: work,
    catch: (cause) =>
      cause instanceof RegistryConflictError || cause instanceof ArtifactValidationError
        ? cause
        : new RegistryError({ operation, cause }),
  });

const sync = <A>(operation: string, work: () => A) =>
  Effect.try({ try: work, catch: (cause) => new RegistryError({ operation, cause }) });

const registryError = (operation: string) => (cause: unknown) =>
  new RegistryError({ operation, cause });

export class R2ArtifactRegistry implements ArtifactRegistry {
  private readonly artifacts: ArtifactStorage;
  private readonly definitions: ArtifactDefinitions;
  constructor(
    storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    bucket: Pick<R2Bucket, "get" | "put">,
    private readonly workspaceId: string,
  ) {
    this.artifacts = new ArtifactStorage(bucket, workspaceId);
    this.definitions = new ArtifactDefinitions(storage, workspaceId);
  }
  workspace() {
    return Effect.succeed(this.workspaceId);
  }
  listSummaries() {
    return Effect.gen({ self: this }, function* () {
      const summaries: DefinitionSummary[] = [];
      const budget = { remaining: ARTIFACT_LIMITS.listBytes };

      for (const row of yield* sync("list definitions", () => this.definitions.pointers())) {
        const summary = yield* this.resolveSummary(row, budget);

        if (summary === null) {
          return yield* Effect.fail(
            new RegistryError({
              operation: "list definitions",
              cause: "The definition disappeared during listing. Retry the request.",
            }),
          );
        }

        summaries.push(summary);
      }

      return summaries;
    });
  }
  summary(slug: string) {
    return Effect.gen({ self: this }, function* () {
      return yield* this.resolveSummary(
        yield* sync("read definition", () => this.definitions.pointer(slug)),
        { remaining: ARTIFACT_LIMITS.listBytes },
      );
    });
  }
  private resolveSummary(
    row: Publication | null,
    budget: { remaining: number },
  ): Effect.Effect<DefinitionSummary | null, RegistryError> {
    return Effect.gen({ self: this }, function* () {
      let current = row;

      for (let attempt = 0; attempt < 8; attempt++) {
        if (current === null) {
          return null;
        }

        const publication = current;
        const saved = yield* sync("decode summary", () => this.definitions.summary(publication));

        if (saved !== null) {
          return saved;
        }

        const repaired = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
            const key = yield* sync(
              "graph key",
              () => `graphs/${hashKey(publication.revision)}.json`,
            );

            const bytes = yield* this.artifacts
              .read(key, Math.min(budget.remaining, ARTIFACT_LIMITS.graphBytes))
              .pipe(Effect.mapError(registryError("read graph")));

            if (!bytes) {
              return yield* Effect.fail(
                new RegistryError({
                  operation: "read graph",
                  cause: "Published graph is missing. Save the loopy again.",
                }),
              );
            }

            budget.remaining -= bytes.byteLength;
            const graph = yield* this.parseGraph(bytes, publication.revision);

            return yield* sync("repair summary", () =>
              this.definitions.repair(
                publication,
                definitionSummary(artifactEntry(publication, graph)),
              ),
            );
          }),
        );

        if (Result.isSuccess(repaired)) {
          current = repaired.success;
        } else {
          const latest = yield* sync("read replacement", () =>
            this.definitions.pointer(publication.slug),
          );

          if (latest?.generation === publication.generation) {
            return yield* Effect.fail(repaired.failure);
          }

          // A replacement can make the old graph irrelevant while its read is in flight.
          current = latest;
        }
      }

      return yield* Effect.fail(
        new RegistryError({
          operation: "repair summary",
          cause: "The definition kept changing during summary backfill. Retry the request.",
        }),
      );
    });
  }
  get(slug: string): Effect.Effect<SavedLoopy | null, RegistryError> {
    return Effect.gen({ self: this }, function* () {
      const row = yield* sync("read definition", () => this.definitions.pointer(slug));

      if (!row) {
        return null;
      }

      const graph = yield* this.revisionGraph(row.revision);

      return yield* sync("read entry", () => artifactEntry(row, graph));
    });
  }
  private parseGraph(bytes: Uint8Array, hash: string) {
    return Effect.gen(function* () {
      const graph = yield* Effect.try({
        try: () => decodeBoundary(graphSchema)(JSON.parse(decoder.decode(bytes))),
        catch: (cause) =>
          new RegistryError({
            operation: "decode graph",
            cause: new Error("Stored graph is invalid. Save the loopy again.", { cause }),
          }),
      });

      const actual = yield* Effect.tryPromise({
        try: () => revision(graph),
        catch: registryError("hash graph"),
      });

      if (actual !== hash) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "verify graph",
            cause: "Stored graph does not match its revision. Save the loopy again.",
          }),
        );
      }

      return graph;
    });
  }
  revisionGraph(hash: string): Effect.Effect<Graph, RegistryError> {
    return Effect.gen({ self: this }, function* () {
      const key = yield* sync("graph key", () => `graphs/${hashKey(hash)}.json`);

      const bytes = yield* this.artifacts
        .read(key, ARTIFACT_LIMITS.graphBytes)
        .pipe(Effect.mapError(registryError("read graph")));

      if (!bytes) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "read graph",
            cause: "Published graph is missing. Save the loopy again.",
          }),
        );
      }

      return yield* this.parseGraph(bytes, hash);
    });
  }
  revisionSource(slug: string, hash: string): Effect.Effect<SourceArtifact, RegistryError> {
    return Effect.gen({ self: this }, function* () {
      const key = yield* sync("source key", () => {
        validateSlug(slug);

        return `sources/${slug}/${hashKey(hash)}.json`;
      });

      const bytes = yield* this.artifacts
        .read(key, ARTIFACT_LIMITS.sourceBytes)
        .pipe(Effect.mapError(registryError("read source")));

      const artifact: SourceArtifact = bytes
        ? yield* sync("decode source", () =>
            decodeJson(sourceArtifactSchema)(decoder.decode(bytes)),
          )
        : unavailableSource(hash, "not_captured");

      if (artifact.revision !== hash) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "verify source",
            cause: "Source artifact does not match the requested revision.",
          }),
        );
      }

      return artifact;
    });
  }
  getBundle(hash: string) {
    return Effect.gen({ self: this }, function* () {
      const key = yield* sync("bundle key", () => `bundles/${hashKey(hash)}.js`);

      const bytes = yield* this.artifacts
        .read(key, ARTIFACT_LIMITS.bundleBytes)
        .pipe(Effect.mapError(registryError("read bundle")));

      if (!bytes) {
        return yield* Effect.fail(
          new RegistryError({
            operation: "read bundle",
            cause: "Published bundle is missing. Save the loopy again.",
          }),
        );
      }

      return bytesToBase64(bytes);
    });
  }
  save(body: PutLoopyBody) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.try({
        try: () => checkArtifactLimits(body, this.workspaceId),
        catch: (cause) => new ArtifactValidationError({ cause }),
      });

      const previous = yield* publicationSync("prepare publication", () =>
        this.definitions.prepare(body),
      );

      const { bundles, sourceArtifact } = yield* validateCompiled(body).pipe(
        Effect.mapError((cause) => new ArtifactValidationError({ cause })),
      );

      const graph = new TextEncoder().encode(canonicalJson(body.graph));
      yield* publicationSync("check capacity", () =>
        this.definitions.capacity.check(body.graph.name, graph.byteLength),
      );

      for (const bundle of bundles) {
        yield* this.artifacts
          .put(`bundles/${bundle.bundleHash}.js`, bundle.bytes)
          .pipe(Effect.mapError(registryError("write bundle")));
      }

      yield* this.artifacts
        .put(`sources/${body.graph.name}/${body.revision}.json`, canonicalJson(sourceArtifact))
        .pipe(Effect.mapError(registryError("write source")));
      yield* this.artifacts
        .put(`graphs/${body.revision}.json`, graph)
        .pipe(Effect.mapError(registryError("write graph")));
      yield* publicationSync("publish definition", () =>
        this.definitions.publish(body, previous, graph.byteLength),
      );
    });
  }
}
