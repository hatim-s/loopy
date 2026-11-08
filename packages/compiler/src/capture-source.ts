import { basename } from "node:path";
import {
  boundaryOptions,
  type SourceArtifact,
  sourceArtifactSchema,
  unavailableSource,
} from "@loopy/contract";
import type { Graph } from "@loopy/core";
import { Schema } from "effect";
import type { AuthorModule } from "./types";

export function captureSource(
  graph: Graph,
  revision: string,
  modules: AuthorModule[],
): SourceArtifact {
  const calls = modules.flatMap((module, index) =>
    (module.sourceCalls ?? []).map((call) => ({ ...call, module, fileId: `file-${index}` })),
  );

  const ranges = graph.nodes.flatMap((node) => {
    const matches = calls.filter((call) => call.kind === node.kind && call.label === node.label);

    const peers = graph.nodes.filter(
      (peer) => peer.kind === node.kind && peer.label === node.label,
    );

    const match = matches[0];

    // Repeated subgraphs and same-label calls cannot be attributed from labels alone.
    if (matches.length !== 1 || peers.length !== 1 || !match) {
      return [];
    }

    return [
      {
        nodeId: node.id,
        fileId: match.fileId,
        startLine: match.module.source.slice(0, match.start).split("\n").length,
        endLine: match.module.source.slice(0, match.end - 1).split("\n").length,
      },
    ];
  });

  const result = Schema.decodeUnknownResult(
    sourceArtifactSchema,
    boundaryOptions,
  )({
    version: 1,
    status: "available",
    revision,
    files: modules.map((module, index) => ({
      id: `file-${index}`,
      path: basename(module.file),
      content: module.source,
    })),
    ranges,
  });

  return result._tag === "Success" ? result.success : unavailableSource(revision, "too_large");
}
