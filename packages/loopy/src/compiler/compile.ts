import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { revision, validateGraph } from "../core/index.js";
import { bundle } from "./bundle.js";
import { captureSource } from "./capture-source.js";
import { type CompilationError, compilerIO, recoverDiagnostics } from "./errors.js";
import { evaluate } from "./evaluate.js";
import { restrict } from "./restrict.js";
import type { CompileResult } from "./types.js";

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
