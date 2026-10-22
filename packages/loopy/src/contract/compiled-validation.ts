import { revision, validateGraph } from "../core/index.js";
import type { PutLoopyBody } from "./compiled-loopy.js";
import { sourceArtifactSchema } from "./source-artifact.js";

/** Verifies compiled contents before either local or cloud storage writes them. */
export async function validateCompiled(body: PutLoopyBody) {
  const diagnostics = validateGraph(body.graph);

  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((item) => item.message).join("\n"));
  }

  const expected = body.graph.nodes.flatMap((node) =>
    node.kind === "code"
      ? [{ nodeId: node.id, bundleHash: node.module.bundleHash }]
      : node.kind === "command" && node.parse
        ? [{ nodeId: node.id, bundleHash: node.parse.bundleHash }]
        : [],
  );

  if (
    expected.length !== body.bundles.length ||
    expected.some(
      (value, index) =>
        value.bundleHash === null ||
        value.nodeId !== body.bundles[index]?.nodeId ||
        value.bundleHash !== body.bundles[index]?.bundleHash,
    )
  ) {
    throw new Error("Supply exactly one bundle for each code node and parser in node order.");
  }

  if ((await revision(body.graph)) !== body.revision) {
    throw new Error("The graph revision does not match its contents.");
  }

  const bundles = [];

  for (const value of body.bundles) {
    const bytes = Uint8Array.from(atob(value.bytes), (character) => character.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    if (hash !== value.bundleHash) {
      throw new Error("Bundle bytes do not match their hash.");
    }

    bundles.push({ ...value, bytes });
  }

  const sourceArtifact = sourceArtifactSchema.parse(
    body.sourceArtifact ?? {
      version: 1,
      status: "unavailable",
      revision: body.revision,
      reason: "not_captured",
    },
  );

  const nodeIds = new Set(body.graph.nodes.map((node) => node.id));

  if (
    sourceArtifact.revision !== body.revision ||
    (sourceArtifact.status === "available" &&
      sourceArtifact.ranges.some((range) => !nodeIds.has(range.nodeId)))
  ) {
    throw new Error("Source must name this compiled revision and its graph nodes.");
  }

  return { bundles, sourceArtifact };
}
