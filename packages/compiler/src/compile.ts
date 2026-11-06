import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { revision, validateGraph } from "@loopy/core";
import { Effect } from "effect";
import { bundle } from "./bundle";
import { captureSource } from "./capture-source";
import { type CompilationError, compilerIO, recoverDiagnostics } from "./errors";
import { evaluate } from "./evaluate";
import { restrict } from "./restrict";
import type { CompileResult } from "./types";

export const compile = (path: string): Effect.Effect<CompileResult, CompilationError> =>
  recoverDiagnostics(
    Effect.gen(function* () {
      const file = yield* compilerIO("resolve entry", resolve(path), () => realpath(resolve(path)));
      const restricted = yield* restrict(file);

      if (!restricted.ok) {
        return restricted;
      }

      const graph = yield* evaluate(file, restricted.modules);
      const diagnostics = validateGraph(graph);

      if (diagnostics.length > 0) {
        return {
          ok: false,
          diagnostics: diagnostics.map((value) => ({
            code: value.code,
            message: value.message,
            file: value.source?.module ?? file,
            line: value.source?.line ?? 1,
            column: value.source?.column ?? 1,
          })),
        } satisfies CompileResult;
      }

      const bundled = yield* bundle(graph, restricted.parsers, file);

      if (!bundled.ok) {
        return bundled;
      }

      const compiledRevision = yield* compilerIO("hash revision", file, () => revision(graph));

      return {
        ok: true,
        graph,
        bundles: bundled.bundles,
        revision: compiledRevision,
        warnings: graph.warnings,
        sourceArtifact: captureSource(graph, compiledRevision, restricted.modules),
      } satisfies CompileResult;
    }),
    resolve(path),
  );
