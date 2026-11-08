import { graphBundles, revision, sha256Hex, validateGraph } from "@loopy/core";
import { Data, Effect } from "effect";
import type { PutLoopyBody } from "./compiled-loopy";
import { unavailableSource } from "./source-artifact";

export class CompiledValidationError extends Data.TaggedError("CompiledValidationError")<{
  code:
    | "invalid_graph"
    | "invalid_bundles"
    | "revision_mismatch"
    | "bundle_mismatch"
    | "invalid_source";
  message: string;
}> {}

export class CompiledHashError extends Data.TaggedError("CompiledHashError")<{ cause: unknown }> {}

export const validateCompiled = Effect.fn("contract.validateCompiled")(function* (
  body: PutLoopyBody,
) {
  const diagnostics = validateGraph(body.graph);

  if (diagnostics.length > 0) {
    return yield* new CompiledValidationError({
      code: "invalid_graph",
      message: diagnostics.map((item) => item.message).join("\n"),
    });
  }

  const expected = graphBundles(body.graph);

  if (
    expected.length !== body.bundles.length ||
    expected.some(
      (value, index) =>
        value.bundleHash === null ||
        value.nodeId !== body.bundles[index]?.nodeId ||
        value.bundleHash !== body.bundles[index]?.bundleHash,
    )
  ) {
    return yield* new CompiledValidationError({
      code: "invalid_bundles",
      message: "Supply exactly one bundle for each code node and parser in node order.",
    });
  }

  if (
    (yield* Effect.tryPromise({
      try: () => revision(body.graph),
      catch: (cause) => new CompiledHashError({ cause }),
    })) !== body.revision
  ) {
    return yield* new CompiledValidationError({
      code: "revision_mismatch",
      message: "The graph revision does not match its contents.",
    });
  }

  const bundles = [];

  for (const value of body.bundles) {
    const bytes = Uint8Array.from(atob(value.bytes), (character) => character.charCodeAt(0));

    const hash = yield* Effect.tryPromise({
      try: () => sha256Hex(bytes),
      catch: (cause) => new CompiledHashError({ cause }),
    });

    if (hash !== value.bundleHash) {
      return yield* new CompiledValidationError({
        code: "bundle_mismatch",
        message: "Bundle bytes do not match their hash.",
      });
    }

    bundles.push({ ...value, bytes });
  }

  const sourceArtifact = body.sourceArtifact ?? unavailableSource(body.revision, "not_captured");

  const nodeIds = new Set(body.graph.nodes.map((node) => node.id));

  if (
    sourceArtifact.revision !== body.revision ||
    (sourceArtifact.status === "available" &&
      sourceArtifact.ranges.some((range) => !nodeIds.has(range.nodeId)))
  ) {
    return yield* new CompiledValidationError({
      code: "invalid_source",
      message: "Source must name this compiled revision and its graph nodes.",
    });
  }

  return { bundles, sourceArtifact };
});
