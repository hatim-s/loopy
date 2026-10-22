import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { ARTIFACT_LIMITS, type ArtifactStorage, hashKey } from "./artifacts-storage.js";

export class ArtifactCapacity {
  constructor(
    private readonly storage: Pick<DurableObjectStorage, "sql">,
    private readonly artifacts: ArtifactStorage,
    private readonly workspace: string,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifact_graph_sizes (
      workspace TEXT NOT NULL, revision TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY (workspace, revision)
    )`);
  }

  async measureCurrent(replacing: string): Promise<void> {
    // Existing pointers must count before any new publication, including after reopening a workspace.
    const missing = this.storage.sql
      .exec<{ revision: string }>(
        `SELECT DISTINCT d.revision FROM artifact_definitions d
         LEFT JOIN artifact_graph_sizes s ON s.workspace = d.workspace AND s.revision = d.revision
         WHERE d.workspace = ? AND d.slug != ? AND s.bytes IS NULL LIMIT ?`,
        this.workspace,
        replacing,
        ARTIFACT_LIMITS.definitions + 1,
      )
      .toArray();

    for (const row of missing) {
      const bytes = await this.artifacts.read(
        `graphs/${hashKey(row.revision)}.json`,
        ARTIFACT_LIMITS.graphBytes,
      );

      if (!bytes) {
        throw new Error("Published graph is missing. Save the loopy again.");
      }

      this.record(row.revision, bytes.byteLength);
    }
  }

  record(revision: string, bytes: number): void {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO artifact_graph_sizes (workspace, revision, bytes) VALUES (?, ?, ?)",
      this.workspace,
      revision,
      bytes,
    );
  }

  check(slug: string, bytes: number): void {
    const remaining = this.storage.sql
      .exec<{ bytes: number; missing: number }>(
        `SELECT coalesce(sum(s.bytes), 0) AS bytes,
         count(*) - count(s.bytes) AS missing FROM artifact_definitions d
         LEFT JOIN artifact_graph_sizes s ON s.workspace = d.workspace AND s.revision = d.revision
         WHERE d.workspace = ? AND d.slug != ?`,
        this.workspace,
        slug,
      )
      .one();

    if (remaining.missing > 0) {
      throw new Error("Workspace graph sizes are incomplete. Retry saving the loopy.");
    }

    if (remaining.bytes + bytes > ARTIFACT_LIMITS.listBytes) {
      throw new Error(
        "Workspace exceeds its 32 MiB current graph capacity. Replace a definition with a smaller graph before saving.",
      );
    }
  }
}
