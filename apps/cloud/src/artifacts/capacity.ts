import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { ArtifactValidationError } from "@loopy/runtime/service";
import { mebibytes } from "../http";
import { ARTIFACT_LIMITS } from "./storage";

export class ArtifactCapacity {
  constructor(
    private readonly storage: Pick<DurableObjectStorage, "sql">,
    private readonly workspace: string,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifact_graph_sizes (
      workspace TEXT NOT NULL, revision TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY (workspace, revision)
    )`);
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
    const current = this.storage.sql
      .exec<{ bytes: number }>(
        `SELECT coalesce(sum(s.bytes), 0) AS bytes FROM artifact_definitions d
         JOIN artifact_graph_sizes s ON s.workspace = d.workspace AND s.revision = d.revision
         WHERE d.workspace = ? AND d.slug != ?`,
        this.workspace,
        slug,
      )
      .one().bytes;

    if (current + bytes > ARTIFACT_LIMITS.listBytes) {
      throw new ArtifactValidationError({
        cause: `Workspace exceeds its ${mebibytes(ARTIFACT_LIMITS.listBytes)} current graph capacity. Replace a definition with a smaller graph before saving.`,
      });
    }
  }
}
