import { createHash } from "node:crypto";
import { canonicalJson, type Graph } from "../core/index.js";

export function revision(graph: Graph, hashes: string[]): string {
  return createHash("sha256").update(canonicalJson(graph)).update(hashes.join("")).digest("hex");
}
