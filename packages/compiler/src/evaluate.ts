import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diagnosticSchema, graphSchema } from "@loopy/contract";
import { errorMessage } from "@loopy/core";
import { compilerLauncher, spawnCaptured } from "@loopy/runtime/local";
import { Effect, Schema } from "effect";
import { AuthorError, CompilationError, compilerIO, EvaluationError } from "./errors";
import { typescriptPaths } from "./source";
import type { AuthorModule } from "./types";

const reportedDiagnostic = Schema.decodeUnknownResult(Schema.fromJsonString(diagnosticSchema), {
  onExcessProperty: "error",
});

export const evaluate = Effect.fn(function* (file: string, modules: AuthorModule[]) {
  return yield* Effect.acquireUseRelease(
    compilerIO("create compiler scratch", file, () => mkdtemp(join(tmpdir(), "loopy-compiler-"))),
    (scratch) =>
      Effect.gen(function* () {
        const canonicalScratch = yield* compilerIO("resolve compiler scratch", scratch, () =>
          realpath(scratch),
        );

        const entry = join(canonicalScratch, "evaluate.ts");
        yield* compilerIO("write evaluator entry", entry, () =>
          writeFile(
            entry,
            `try {
        const {default: result} = await import(${JSON.stringify(file)});
        process.stdout.write(JSON.stringify(result.graph));
      } catch(error) {
        process.stderr.write(error instanceof Error && "diagnostic" in error ? JSON.stringify(error.diagnostic) : String(error));
        process.exitCode = 1;
      }`,
          ),
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
                  build.onResolve({ filter: /^loopy(?:\/graph)?$/ }, () => ({
                    path: Bun.resolveSync("@loopy/sdk/graph", import.meta.dir),
                  }));
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
          return yield* new AuthorError({
            code: "evaluation_failed",
            file,
            message: result.logs.join("\n"),
          });
        }

        const executable = join(canonicalScratch, "evaluate.js");
        const bytes = yield* compilerIO("read evaluator bytes", file, () => output.arrayBuffer());
        yield* compilerIO("write evaluator", executable, () =>
          writeFile(executable, new Uint8Array(bytes)),
        );
        const cwd = yield* compilerIO("resolve evaluator cwd", file, () => realpath(dirname(file)));

        const compilerProgram = yield* compilerIO("resolve compiler executable", file, () =>
          realpath(process.execPath),
        );

        const [program, args] = yield* compilerLauncher(compilerProgram, cwd).pipe(
          Effect.mapError(
            (cause) => new CompilationError({ operation: "compiler launcher", file, cause }),
          ),
        );

        const captured = yield* spawnCaptured(
          {
            program,
            args: [...args, "--smol", executable],
            cwd,
            env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
          },
          { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 * 1024 },
          undefined,
          performance.now(),
        ).pipe(
          Effect.catchTag(
            "CommandExecutionError",
            (cause): Effect.Effect<never, AuthorError | CompilationError> =>
              cause.reason === "timeout" ||
              cause.reason === "output_limit" ||
              cause.reason === "rejected"
                ? Effect.fail(
                    new AuthorError({ code: "evaluation_failed", file, message: cause.message }),
                  )
                : Effect.fail(
                    new CompilationError({ operation: "execute evaluator", file, cause }),
                  ),
          ),
        );

        if (captured.exitCode !== 0) {
          const reported = reportedDiagnostic(captured.stderr);

          if (reported._tag === "Success") {
            return yield* new EvaluationError({ diagnostic: reported.success });
          }

          return yield* new AuthorError({
            code: "evaluation_failed",
            file,
            message: captured.stderr || "Compiler process failed.",
          });
        }

        // BOUNDARY: The isolated process returns untrusted author-produced graph JSON.
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(graphSchema), {
          onExcessProperty: "error",
        })(captured.stdout).pipe(
          Effect.mapError(
            (cause) =>
              new AuthorError({ code: "evaluation_failed", file, message: errorMessage(cause) }),
          ),
        );
      }),
    (scratch) =>
      compilerIO("remove compiler scratch", scratch, () =>
        rm(scratch, { recursive: true, force: true }),
      ),
  );
});
