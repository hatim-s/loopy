import type { R2Bucket, SqlStorage } from "@cloudflare/workers-types";
import type { PutLoopyBody } from "@loopy/contract";
import { canonicalJson } from "@loopy/core";
import { r2Key } from "../../src/artifacts/storage";

/** Stores a definition as releases before summary projections did: a pointer row and its graph. */
export async function seedLegacyPointer(
  options: { sql: SqlStorage; bucket: Pick<R2Bucket, "put">; workspace: string },
  body: PutLoopyBody,
  pointer: { savedAt: string; generation: string },
) {
  const { sql, bucket, workspace } = options;
  sql.exec(`CREATE TABLE artifact_definitions (
    workspace TEXT NOT NULL, slug TEXT NOT NULL, revision TEXT NOT NULL,
    source TEXT NOT NULL, saved_at TEXT NOT NULL, generation TEXT NOT NULL,
    PRIMARY KEY (workspace, slug)
  )`);
  await bucket.put(
    r2Key.workspace(workspace) + r2Key.graph(body.revision),
    canonicalJson(body.graph),
  );
  sql.exec(
    "INSERT INTO artifact_definitions VALUES (?, ?, ?, ?, ?, ?)",
    workspace,
    body.graph.name,
    body.revision,
    body.source.path,
    pointer.savedAt,
    pointer.generation,
  );
}
