import { createHash } from "node:crypto";
import type { Json } from "loopy";
import { object, parse, string } from "./json-edit.ts";

export type TreeEntry = { path: string; mode: string; type: string; sha: string };

// BOUNDARY: A complete GitHub tree is required to reconstruct the exact Git object.
export function parseTree(raw: string): TreeEntry[] {
  const result = object(parse(raw), "Git tree");

  if (result.truncated !== false || !Array.isArray(result.tree)) {
    throw new Error("Cannot verify a missing or truncated Git tree.");
  }

  return result.tree.map(treeEntry);
}

// BOUNDARY: Git tree entries retain their object IDs, names and file modes.
function treeEntry(value: Json): TreeEntry {
  const entry = object(value, "Git tree entry");
  const path = string(entry.path, "Git tree path");
  const mode = string(entry.mode, "Git tree mode");
  const type = string(entry.type, "Git tree type");
  const sha = string(entry.sha, "Git tree SHA");

  if (
    !path ||
    /[\0/]/.test(path) ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    !["040000", "100644", "100755", "120000", "160000"].includes(mode)
  ) {
    throw new Error("GitHub returned an invalid tree entry.");
  }

  return { path, mode, type, sha };
}

function hashObject(type: string, bytes: Uint8Array) {
  return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
}

export function blobSha(contents: string) {
  return hashObject("blob", Buffer.from(contents));
}

export function hashTree(entries: TreeEntry[]) {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(
      Buffer.from(`${a.path}${a.type === "tree" ? "/" : ""}`),
      Buffer.from(`${b.path}${b.type === "tree" ? "/" : ""}`),
    ),
  );

  const bytes = sorted.flatMap((entry) => [
    Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.path}\0`),
    Buffer.from(entry.sha, "hex"),
  ]);

  return hashObject("tree", Buffer.concat(bytes));
}

export function patchTree(
  entries: TreeEntry[],
  changes: { path: string; contents: string }[],
  children: Record<string, string>,
) {
  const next = entries.map((entry) => {
    const leaf = changes.find((change) => change.path === entry.path);

    return { ...entry, sha: children[entry.path] ?? (leaf ? blobSha(leaf.contents) : entry.sha) };
  });

  if (
    changes.some((change) => !entries.some((entry) => entry.path === change.path.split("/")[0]))
  ) {
    throw new Error("Expected asset file is missing from the recorded base tree.");
  }

  return hashTree(next);
}
