import { createHash } from "node:crypto";
import { readCommit, readSnapshot, readTree } from "./github.ts";
import { planSync, sourceFiles, syncMetadata, targetFiles } from "./sync.ts";

export function blobSha(contents: string) {
  const bytes = Buffer.from(contents);

  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export async function verifyExisting(sha: string) {
  const commit = await readCommit(sha);
  const metadata = syncMetadata(commit.message);
  const source = await readSnapshot("www", metadata.source, sourceFiles);
  const target = await readSnapshot("uacode", metadata.base, targetFiles);
  const changes = planSync(source, target, metadata.source);
  const files = await readTree(metadata.base, sha);

  if (
    files.length !== changes.length ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file) => {
      const planned = changes.find((change) => change.path === file.path);

      return !planned || file.status !== "modified" || file.sha !== blobSha(planned.contents);
    })
  ) {
    throw new Error("Refusing to update a sync branch with manual tree edits. Review it manually.");
  }

  return { sha, tree: commit.tree };
}
