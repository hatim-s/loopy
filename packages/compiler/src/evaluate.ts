import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boundaryOptions, diagnosticSchema, graphSchema } from "@loopy/contract";
import { errorMessage } from "@loopy/core";
import { spawnCaptured, withBundleSandbox } from "@loopy/runtime/os";
import { evaluatorSource, graphEntry } from "@loopy/sdk/graph-host";
import { Effect, Schema } from "effect";
import {
  AuthorDiagnostics,
  authorFailure,
  CompilationError,
  compilerIO,
  graphDiagnostics,
} from "./errors";
import { SDK_SPECIFIER } from "./restrict";
import { typescriptPaths } from "./source-paths";
import type { AuthorModule } from "./types";

const reportedDiagnostic = Schema.decodeUnknownResult(
  Schema.fromJsonString(diagnosticSchema),
  boundaryOptions,
);

const EVALUATION_TIMEOUT_MS = 10_000;

const EVALUATION_OUTPUT_BYTES = 16 * 1024 * 1024;

export const evaluate = Effect.fn(function* (
  file: string,
  modules: readonly Pick<AuthorModule, "file" | "evaluated">[],
) {
  return yield* Effect.acquireUseRelease(
    compilerIO("create compiler scratch", file, () => mkdtemp(join(tmpdir(), "loopy-compiler-"))),
    (scratch) =>
      Effect.gen(function* () {
        const canonicalScratch = yield* compilerIO("resolve compiler scratch", scratch, () =>
          realpath(scratch),
        );

        const entry = join(canonicalScratch, "evaluate.ts");
        yield* compilerIO("write evaluator entry", entry, () =>
          writeFile(entry, evaluatorSource(file)),
        );
        const sources = new Map(modules.map((module) => [module.file, module.evaluated]));

        const result = yield* compilerIO("build evaluator", file, () =>
          Bun.build({
            throw: false,
            entrypoints: [entry],
            target: "bun",
            format: "esm",
            plugins: [
              typescriptPaths,
              {
                name: "restricted-author-source",
                setup(build) {
                  build.onResolve({ filter: /^loopy/ }, ({ path }) =>
                    path === SDK_SPECIFIER ? { path: graphEntry() } : undefined,
                  );
                  build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
                    const source = sources.get(path);

                    return source === undefined
                      ? undefined
                      : {
                          contents: source,
                          resolveDir: dirname(path),
                          loader: path.endsWith("tsx") ? "tsx" : "ts",
                        };
                  });
                },
              },
            ],
          }),
        );

        const output = result.outputs[0];

        if (!result.success || !output) {
          return yield* authorFailure("evaluation_failed", file, result.logs.join("\n"));
        }

        const executable = join(canonicalScratch, "evaluate.js");
        const bytes = yield* compilerIO("read evaluator bytes", file, () => output.arrayBuffer());
        yield* compilerIO("write evaluator", executable, () =>
          writeFile(executable, new Uint8Array(bytes)),
        );

        // The scratch workspace holds only the evaluator, so no state inside it needs hiding.
        const captured = yield* withBundleSandbox(
          { bundle: executable, workspace: canonicalScratch, network: false, home: null },
          ({ program, args }) =>
            spawnCaptured(
              {
                program,
                args,
                cwd: canonicalScratch,
                env: { PATH: "/usr/bin:/bin", HOME: canonicalScratch, TMPDIR: canonicalScratch },
              },
              { timeoutMs: EVALUATION_TIMEOUT_MS, maxOutputBytes: EVALUATION_OUTPUT_BYTES },
            ),
        ).pipe(
          Effect.catchTags({
            ScratchCleanupError: (cause) =>
              Effect.fail(
                new CompilationError({ operation: "remove evaluator scratch", file, cause }),
              ),
            ProcessFilesystemError: (cause) =>
              Effect.fail(new CompilationError({ operation: "stage evaluator", file, cause })),
          }),
          Effect.catchTag(
            "CommandExecutionError",
            (cause): Effect.Effect<never, AuthorDiagnostics | CompilationError> =>
              cause.reason === "timeout" ||
              cause.reason === "output_limit" ||
              cause.reason === "rejected"
                ? Effect.fail(authorFailure("evaluation_failed", file, cause.message))
                : Effect.fail(
                    new CompilationError({ operation: "execute evaluator", file, cause }),
                  ),
          ),
        );

        if (captured.exitCode !== 0) {
          const reported = reportedDiagnostic(captured.stderr);

          if (reported._tag === "Success") {
            return yield* new AuthorDiagnostics({
              diagnostics: graphDiagnostics([reported.success], file),
            });
          }

          return yield* authorFailure(
            "evaluation_failed",
            file,
            captured.stderr || "Compiler process failed.",
          );
        }

        // BOUNDARY: The isolated process returns untrusted author-produced graph JSON.
        return yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(graphSchema),
          boundaryOptions,
        )(captured.stdout).pipe(
          Effect.mapError((cause) => authorFailure("evaluation_failed", file, errorMessage(cause))),
        );
      }),
    (scratch) =>
      compilerIO("remove compiler scratch", scratch, () =>
        rm(scratch, { recursive: true, force: true }),
      ),
  );
});
