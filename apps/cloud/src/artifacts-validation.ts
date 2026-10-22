import type {
  Graph,
  PutLoopyBody,
  SavedLoopy,
} from "../../../packages/loopy/src/contract/index.js";
import { canonicalJson } from "../../../packages/loopy/src/core/index.js";
import { ARTIFACT_LIMITS } from "./artifacts-storage.js";

const encoder = new TextEncoder();

export function checkArtifactLimits(body: PutLoopyBody, workspaceId: string): void {
  if (body.source.workspace !== workspaceId) {
    throw new Error("Source workspace does not match the authenticated workspace.");
  }

  if (body.graph.meta.mode !== "sandbox" || body.graph.meta.secrets.length > 0) {
    throw new Error(
      "Cloud phase 1 supports sandbox mode without declared secrets. Set mode to sandbox and remove secrets before saving.",
    );
  }

  const sizes = body.bundles.map(
    (bundle) =>
      (bundle.bytes.length * 3) / 4 -
      (bundle.bytes.endsWith("==") ? 2 : bundle.bytes.endsWith("=") ? 1 : 0),
  );

  if (
    encoder.encode(JSON.stringify(body)).length > ARTIFACT_LIMITS.requestBytes ||
    encoder.encode(canonicalJson(body.graph)).length > ARTIFACT_LIMITS.graphBytes ||
    sizes.reduce((sum, bytes) => sum + bytes, 0) > ARTIFACT_LIMITS.totalBundleBytes ||
    sizes.some((bytes) => bytes > ARTIFACT_LIMITS.bundleBytes)
  ) {
    throw new Error(
      "Compiled artifacts exceed cloud limits: 24 MiB request, 1 MiB graph, 8 MiB per bundle, 16 MiB total bundles.",
    );
  }
}

export function graphBundles(graph: Graph): SavedLoopy["bundles"] {
  return graph.nodes.flatMap((node) => {
    const executable =
      node.kind === "code" ? node.module : node.kind === "command" ? node.parse : null;

    if (!executable) {
      return [];
    }

    if (executable.bundleHash === null) {
      throw new Error("Stored graph has an uncompiled executable. Save the loopy again.");
    }

    return [{ nodeId: node.id, bundleHash: executable.bundleHash }];
  });
}
