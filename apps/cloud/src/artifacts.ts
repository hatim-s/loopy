import type { DurableObjectStorage, R2Bucket } from "@cloudflare/workers-types";
import {
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
import { ArtifactCapacity } from "./artifacts-capacity.js";
import { ARTIFACT_LIMITS, ArtifactStorage, bytesToBase64, hashKey } from "./artifacts-storage.js";
import { checkArtifactLimits, graphBundles } from "./artifacts-validation.js";

export { ARTIFACT_LIMITS } from "./artifacts-storage.js";

type Publication = {
  slug: string;
  revision: string;
  source: string;
  saved_at: string;
  generation: string;
};

const decoder = new TextDecoder();

export class R2ArtifactRegistry implements ArtifactRegistry {
  private readonly artifacts: ArtifactStorage;
  private readonly capacity: ArtifactCapacity;

  constructor(
    private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    bucket: R2Bucket,
    private readonly workspaceId: string,
  ) {
    this.artifacts = new ArtifactStorage(bucket, workspaceId);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifact_definitions (
      workspace TEXT NOT NULL, slug TEXT NOT NULL, revision TEXT NOT NULL,
      source TEXT NOT NULL, saved_at TEXT NOT NULL, generation TEXT NOT NULL,
      PRIMARY KEY (workspace, slug)
    )`);
    this.capacity = new ArtifactCapacity(storage, this.artifacts, workspaceId);
  }

  async workspace(): Promise<string> {
    return this.workspaceId;
  }

  private pointer(slug: string): Publication | null {
    validateSlug(slug);

    return (
      this.storage.sql
        .exec<Publication>(
          "SELECT slug, revision, source, saved_at, generation FROM artifact_definitions WHERE workspace = ? AND slug = ?",
          this.workspaceId,
          slug,
        )
        .toArray()[0] ?? null
    );
  }

  async list(): Promise<SavedLoopy[]> {
    const rows = this.storage.sql
      .exec<Publication>(
        "SELECT slug, revision, source, saved_at, generation FROM artifact_definitions WHERE workspace = ? ORDER BY slug LIMIT ?",
        this.workspaceId,
        ARTIFACT_LIMITS.definitions + 1,
      )
      .toArray();

    if (rows.length > ARTIFACT_LIMITS.definitions) {
      throw new Error(
        "Workspace exceeds the 1000 definition capacity. Remove definitions before listing.",
      );
    }

    const entries: SavedLoopy[] = [];
    let remaining = ARTIFACT_LIMITS.listBytes;

    for (const row of rows) {
      const bytes = await this.artifacts.read(
        `graphs/${hashKey(row.revision)}.json`,
        Math.min(remaining, ARTIFACT_LIMITS.graphBytes),
      );

      if (!bytes) {
        throw new Error("Published graph is missing. Save the loopy again.");
      }

      remaining -= bytes.byteLength;
      entries.push(this.entry(row, await this.parseGraph(bytes, row.revision)));
    }

    return entries;
  }

  async get(slug: string): Promise<SavedLoopy> {
    const row = this.pointer(slug);

    if (!row) {
      throw new Error(`No saved loopy '${slug}'. Use loopy save <file.ts> first.`);
    }

    return this.entry(row, await this.revisionGraph(row.revision));
  }

  private entry(row: Publication, graph: Graph): SavedLoopy {
    return {
      version: 2,
      slug: row.slug,
      graph,
      revision: row.revision,
      source: row.source,
      savedAt: row.saved_at,
      scope: graph.meta.scope,
      description: graph.meta.description,
      input: graph.input,
      schedule: graph.meta.schedule,
      mode: graph.meta.mode,
      secrets: graph.meta.secrets,
      bundles: graphBundles(graph),
    };
  }

  private async parseGraph(bytes: Uint8Array, hash: string): Promise<Graph> {
    const graph = graphSchema.parse(JSON.parse(decoder.decode(bytes)));

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
    const previous = this.pointer(body.graph.name);
    this.checkOwner(previous, body);
    this.checkCapacity(previous);

    const { bundles, sourceArtifact } = await validateCompiled(body);
    const graph = new TextEncoder().encode(canonicalJson(body.graph));
    await this.capacity.measureCurrent(body.graph.name);
    this.capacity.check(body.graph.name, graph.byteLength);

    for (const bundle of bundles) {
      await this.artifacts.put(`bundles/${bundle.bundleHash}.js`, bundle.bytes);
    }

    await this.artifacts.put(
      `sources/${body.graph.name}/${body.revision}.json`,
      canonicalJson(sourceArtifact),
    );
    await this.artifacts.put(`graphs/${body.revision}.json`, graph);

    this.storage.transactionSync(() => {
      const current = this.pointer(body.graph.name);
      this.checkOwner(current, body);

      if (current?.generation !== previous?.generation) {
        throw new Error(
          "The definition changed during save. Retry against its current source owner.",
        );
      }

      this.checkCapacity(current);
      this.capacity.record(body.revision, graph.byteLength);
      this.capacity.check(body.graph.name, graph.byteLength);

      if (current?.revision === body.revision && current.source === body.source.path) {
        return;
      }

      this.storage.sql.exec(
        `INSERT INTO artifact_definitions (workspace, slug, revision, source, saved_at, generation)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace, slug) DO UPDATE SET
         revision = excluded.revision, source = excluded.source, saved_at = excluded.saved_at, generation = excluded.generation`,
        this.workspaceId,
        body.graph.name,
        body.revision,
        body.source.path,
        new Date().toISOString(),
        crypto.randomUUID(),
      );
    });
  }

  private checkCapacity(current: Publication | null): void {
    if (current) {
      return;
    }

    const count = this.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM artifact_definitions WHERE workspace = ?",
        this.workspaceId,
      )
      .one().count;

    if (count >= ARTIFACT_LIMITS.definitions) {
      throw new Error(
        "Workspace has reached its 1000 definition capacity. Replace an existing definition or remove one first.",
      );
    }
  }

  private checkOwner(previous: Publication | null, body: PutLoopyBody): void {
    if (previous && previous.source !== body.source.path && !body.replace) {
      throw new Error(
        `Slug '${body.graph.name}' belongs to another source. Rename it or use --replace.`,
      );
    }
  }
}
