import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { revision, validateGraph } from "@loopy/core";
import { Effect } from "effect";
import { bundle } from "./bundle";
import { captureSource } from "./capture-source";
import {
  AuthorDiagnostics,
  type CompilationError,
  compilerIO,
  graphDiagnostics,
  recoverDiagnostics,
} from "./errors";
import { evaluate } from "./evaluate";
import { restrict } from "./restrict";
import type { CompileResult } from "./types";

export const compile = (path: string): Effect.Effect<CompileResult, CompilationError> =>
  recoverDiagnostics(
    Effect.gen(function* () {
      const file = yield* compilerIO("resolve entry", resolve(path), () => realpath(resolve(path)));
      const modules = yield* restrict(file);
      const evaluated = yield* evaluate(file, modules);
      const diagnostics = validateGraph(evaluated);

      if (diagnostics.length > 0) {
        return yield* new AuthorDiagnostics({ diagnostics: graphDiagnostics(diagnostics, file) });
      }

      const { graph, bundles } = yield* bundle(evaluated, file);
      const compiledRevision = yield* compilerIO("hash revision", file, () => revision(graph));

      return {
        ok: true,
        graph,
        bundles,
        revision: compiledRevision,
        sourceArtifact: captureSource(graph, compiledRevision, modules),
      } satisfies CompileResult;
    }),
    resolve(path),
  );
