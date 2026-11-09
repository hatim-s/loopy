import type { PutLoopyBody } from "@loopy/contract";
import { canonicalJson } from "@loopy/core";
import { mebibytes } from "../http";
import { checkDefinitionRows } from "./projection";
import { ARTIFACT_LIMITS } from "./storage";

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

  checkDefinitionRows(body);

  const sizes = body.bundles.map((bundle) => bundle.bytes.byteLength);

  // The Worker already caps the request at CLOUD_MAX_REQUEST_BYTES before decoding it.
  if (
    encoder.encode(canonicalJson(body.graph)).length > ARTIFACT_LIMITS.graphBytes ||
    sizes.reduce((sum, bytes) => sum + bytes, 0) > ARTIFACT_LIMITS.totalBundleBytes ||
    sizes.some((bytes) => bytes > ARTIFACT_LIMITS.bundleBytes)
  ) {
    throw new Error(
      `Compiled artifacts exceed cloud limits: ${mebibytes(ARTIFACT_LIMITS.graphBytes)} graph, ${mebibytes(ARTIFACT_LIMITS.bundleBytes)} per bundle, ${mebibytes(ARTIFACT_LIMITS.totalBundleBytes)} total bundles.`,
    );
  }
}
