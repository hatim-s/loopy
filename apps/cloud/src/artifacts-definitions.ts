import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  type DefinitionSummary,
  definitionSummary,
  type PutLoopyBody,
} from "../../../packages/loopy/src/contract/index.js";
import { validateSlug } from "../../../packages/loopy/src/core/index.js";
import { ArtifactCapacity } from "./artifacts-capacity.js";
import {
  checkProjectionRow,
  definitionProjectionSchema,
  projectionJson,
} from "./artifacts-projection.js";
import { ARTIFACT_LIMITS, type ArtifactStorage } from "./artifacts-storage.js";
import { artifactEntry } from "./artifacts-validation.js";

export type Publication = {
  slug: string;
  revision: string;
  source: string;
  saved_at: string;
  generation: string;
  projection_json: string | null;
};

export class ArtifactDefinitions {
  readonly capacity: ArtifactCapacity;

  constructor(
    private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    artifacts: ArtifactStorage,
    private readonly workspace: string,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifact_definitions (
      workspace TEXT NOT NULL, slug TEXT NOT NULL, revision TEXT NOT NULL,
      source TEXT NOT NULL, saved_at TEXT NOT NULL, generation TEXT NOT NULL,
      PRIMARY KEY (workspace, slug)
    )`);

    storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifact_definition_summaries (
      workspace TEXT NOT NULL, slug TEXT NOT NULL, generation TEXT NOT NULL,
      projection_json TEXT NOT NULL, PRIMARY KEY (workspace, slug)
    )`);

    this.capacity = new ArtifactCapacity(storage, artifacts, workspace);
  }

  pointer(slug: string): Publication | null {
    validateSlug(slug);

    return (
      this.storage.sql
        .exec<Publication>(
          `SELECT d.slug, d.revision, d.source, d.saved_at, d.generation, s.projection_json
           FROM artifact_definitions d LEFT JOIN artifact_definition_summaries s
           ON s.workspace = d.workspace AND s.slug = d.slug AND s.generation = d.generation
           WHERE d.workspace = ? AND d.slug = ?`,
          this.workspace,
          slug,
        )
        .toArray()[0] ?? null
    );
  }

  pointers(): Publication[] {
    const rows = this.storage.sql
      .exec<Publication>(
        `SELECT d.slug, d.revision, d.source, d.saved_at, d.generation, s.projection_json
         FROM artifact_definitions d LEFT JOIN artifact_definition_summaries s
         ON s.workspace = d.workspace AND s.slug = d.slug AND s.generation = d.generation
         WHERE d.workspace = ? ORDER BY d.slug LIMIT ?`,
        this.workspace,
        ARTIFACT_LIMITS.definitions + 1,
      )
      .toArray();

    if (rows.length > ARTIFACT_LIMITS.definitions) {
      throw new Error(
        "Workspace exceeds the 1000 definition capacity. Remove definitions before listing.",
      );
    }

    return rows;
  }

  summary(row: Publication): DefinitionSummary | null {
    if (row.projection_json === null) {
      return null;
    }

    return {
      slug: row.slug,
      revision: row.revision,
      source: row.source,
      savedAt: row.saved_at,
      ...definitionProjectionSchema.parse(JSON.parse(row.projection_json)),
    };
  }

  private writeProjection(row: Publication, projection: string): void {
    checkProjectionRow({
      workspace: this.workspace,
      slug: row.slug,
      generation: row.generation,
      projection,
    });
    this.storage.sql.exec(
      `INSERT INTO artifact_definition_summaries (workspace, slug, generation, projection_json)
       VALUES (?, ?, ?, ?) ON CONFLICT (workspace, slug) DO UPDATE SET
       generation = excluded.generation, projection_json = excluded.projection_json`,
      this.workspace,
      row.slug,
      row.generation,
      projection,
    );
  }

  repair(row: Publication, summary: DefinitionSummary): Publication | null {
    return this.storage.transactionSync(() => {
      const current = this.pointer(row.slug);

      if (current?.generation !== row.generation || current.projection_json !== null) {
        return current;
      }

      this.writeProjection(current, projectionJson(summary));

      return this.pointer(row.slug);
    });
  }

  prepare(body: PutLoopyBody): Publication | null {
    const previous = this.pointer(body.graph.name);
    this.checkOwner(previous, body);
    this.checkCapacity(previous);

    return previous;
  }

  publish(body: PutLoopyBody, previous: Publication | null, bytes: number): void {
    this.storage.transactionSync(() => {
      const current = this.pointer(body.graph.name);
      this.checkOwner(current, body);

      if (current?.generation !== previous?.generation) {
        throw new Error(
          "The definition changed during save. Retry against its current source owner.",
        );
      }

      this.checkCapacity(current);
      this.capacity.record(body.revision, bytes);
      this.capacity.check(body.graph.name, bytes);

      // An identical save repairs derived metadata without publishing a new version.
      const row =
        current?.revision === body.revision && current.source === body.source.path
          ? current
          : {
              slug: body.graph.name,
              revision: body.revision,
              source: body.source.path,
              saved_at: new Date().toISOString(),
              generation: crypto.randomUUID(),
              projection_json: null,
            };

      const summary = projectionJson(definitionSummary(artifactEntry(row, body.graph)));

      if (row.projection_json === summary) {
        return;
      }

      this.storage.sql.exec(
        `INSERT INTO artifact_definitions (workspace, slug, revision, source, saved_at, generation)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace, slug) DO UPDATE SET
         revision = excluded.revision, source = excluded.source, saved_at = excluded.saved_at,
         generation = excluded.generation`,
        this.workspace,
        row.slug,
        row.revision,
        row.source,
        row.saved_at,
        row.generation,
      );
      this.writeProjection(row, summary);
    });
  }

  private checkCapacity(current: Publication | null): void {
    if (current) {
      return;
    }

    const count = this.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM artifact_definitions WHERE workspace = ?",
        this.workspace,
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
