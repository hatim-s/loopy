import type { DurableObjectStorage, R2Bucket } from "@cloudflare/workers-types";
import {
  type DefinitionSummary,
  definitionSummary,
  type Graph,
  graphSchema,
  type PutLoopyBody,
  type SavedLoopy,
  type SourceArtifact,
  sourceArtifactSchema,
  validateCompiled,
} from "../../../packages/loopy/src/contract/index.js";
import { canonicalJson, revision, validateSlug } from "../../../packages/loopy/src/core/index.js";
import type { ArtifactRegistry } from "../../../packages/loopy/src/service/index.js";
import { ArtifactDefinitions, type Publication } from "./artifacts-definitions.js";
import { ARTIFACT_LIMITS, ArtifactStorage, bytesToBase64, hashKey } from "./artifacts-storage.js";
import { artifactEntry, checkArtifactLimits } from "./artifacts-validation.js";

export { ARTIFACT_LIMITS } from "./artifacts-storage.js";

const decoder = new TextDecoder();

export class R2ArtifactRegistry implements ArtifactRegistry {
  private readonly artifacts: ArtifactStorage;
  private readonly definitions: ArtifactDefinitions;

  constructor(
    storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    bucket: Pick<R2Bucket, "get" | "put">,
    private readonly workspaceId: string,
  ) {
    this.artifacts = new ArtifactStorage(bucket, workspaceId);
    this.definitions = new ArtifactDefinitions(storage, this.artifacts, workspaceId);
  }

  async workspace(): Promise<string> {
    return this.workspaceId;
  }

  async listSummaries(): Promise<DefinitionSummary[]> {
    const summaries: DefinitionSummary[] = [];
    const budget = { remaining: ARTIFACT_LIMITS.listBytes };

    for (const row of this.definitions.pointers()) {
      const summary = await this.resolveSummary(row, budget);

      if (summary === null) {
        throw new Error("The definition disappeared during listing. Retry the request.");
      }

      summaries.push(summary);
    }

    return summaries;
  }

  async summary(slug: string): Promise<DefinitionSummary | null> {
    return this.resolveSummary(this.definitions.pointer(slug), {
      remaining: ARTIFACT_LIMITS.listBytes,
    });
  }

  private async resolveSummary(
    row: Publication | null,
    budget: { remaining: number },
  ): Promise<DefinitionSummary | null> {
    let current = row;

    for (let attempt = 0; attempt < 8; attempt++) {
      if (current === null) {
        return null;
      }

      const saved = this.definitions.summary(current);

      if (saved !== null) {
        return saved;
      }

      const publication = current;

      try {
        const bytes = await this.artifacts.read(
          `graphs/${hashKey(publication.revision)}.json`,
          Math.min(budget.remaining, ARTIFACT_LIMITS.graphBytes),
        );

        if (!bytes) {
          throw new Error("Published graph is missing. Save the loopy again.");
        }

        budget.remaining -= bytes.byteLength;
        const graph = await this.parseGraph(bytes, publication.revision);
        current = this.definitions.repair(
          publication,
          definitionSummary(artifactEntry(publication, graph)),
        );
      } catch (error) {
        const latest = this.definitions.pointer(publication.slug);

        if (latest?.generation === publication.generation) {
          throw error;
        }

        // A replacement can make the old graph irrelevant while its read is in flight.
        current = latest;
      }
    }

    throw new Error("The definition kept changing during summary backfill. Retry the request.");
  }

  async get(slug: string): Promise<SavedLoopy | null> {
    const row = this.definitions.pointer(slug);

    if (!row) {
      return null;
    }

    return artifactEntry(row, await this.revisionGraph(row.revision));
  }

  private async parseGraph(bytes: Uint8Array, hash: string): Promise<Graph> {
    let graph: Graph;

    try {
      graph = graphSchema.parse(JSON.parse(decoder.decode(bytes)));
    } catch (cause) {
      throw new Error("Stored graph is invalid. Save the loopy again.", { cause });
    }

    if ((await revision(graph)) !== hash) {
      throw new Error("Stored graph does not match its revision. Save the loopy again.");
    }

    return graph;
  }

  async revisionGraph(hash: string): Promise<Graph> {
    const bytes = await this.artifacts.read(
      `graphs/${hashKey(hash)}.json`,
      ARTIFACT_LIMITS.graphBytes,
    );

    if (!bytes) {
      throw new Error("Published graph is missing. Save the loopy again.");
    }

    return this.parseGraph(bytes, hash);
  }

  async revisionSource(slug: string, hash: string): Promise<SourceArtifact> {
    validateSlug(slug);

    const bytes = await this.artifacts.read(
      `sources/${slug}/${hashKey(hash)}.json`,
      ARTIFACT_LIMITS.sourceBytes,
    );

    const artifact = bytes
      ? sourceArtifactSchema.parse(JSON.parse(decoder.decode(bytes)))
      : this.unavailable(hash);

    if (artifact.revision !== hash) {
      throw new Error("Source artifact does not match the requested revision.");
    }

    return artifact;
  }

  async getBundle(hash: string): Promise<string> {
    const bytes = await this.artifacts.read(
      `bundles/${hashKey(hash)}.js`,
      ARTIFACT_LIMITS.bundleBytes,
    );

    if (!bytes) {
      throw new Error("Published bundle is missing. Save the loopy again.");
    }

    return bytesToBase64(bytes);
  }

  private unavailable(hash: string): SourceArtifact {
    return { version: 1, status: "unavailable", revision: hash, reason: "not_captured" };
  }

  async save(body: PutLoopyBody): Promise<void> {
    checkArtifactLimits(body, this.workspaceId);
    const previous = this.definitions.prepare(body);

    const { bundles, sourceArtifact } = await validateCompiled(body);
    const graph = new TextEncoder().encode(canonicalJson(body.graph));
    await this.definitions.capacity.measureCurrent(body.graph.name);
    this.definitions.capacity.check(body.graph.name, graph.byteLength);

    for (const bundle of bundles) {
      await this.artifacts.put(`bundles/${bundle.bundleHash}.js`, bundle.bytes);
    }

    await this.artifacts.put(
      `sources/${body.graph.name}/${body.revision}.json`,
      canonicalJson(sourceArtifact),
    );
    await this.artifacts.put(`graphs/${body.revision}.json`, graph);

    this.definitions.publish(body, previous, graph.byteLength);
  }
}
