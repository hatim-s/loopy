import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { diagnosticSchema, graphSchema } from "../contract/index.js";
import type { Diagnostic } from "../core/index.js";
import { spawnCaptured, withBundleSandbox } from "../executor/index.js";
import { typescriptPaths } from "./source.js";
import type { AuthorModule } from "./types.js";

export class EvaluationError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

function reportedDiagnostic(stderr: string) {
  try {
    return diagnosticSchema.safeParse(JSON.parse(stderr));
  } catch {
    return null;
  }
}

export async function evaluate(
  file: string,
  modules: AuthorModule[],
  home = resolve(process.env.LOOPY_HOME ?? join(homedir(), ".loopy")),
) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "loopy-compiler-")));

  try {
    const entry = join(scratch, "evaluate.ts");
    await writeFile(
      entry,
      `try {
        const {default: result} = await import(${JSON.stringify(file)});
        process.stdout.write(JSON.stringify(result.graph));
      } catch(error) {
        process.stderr.write(error instanceof Error && "diagnostic" in error ? JSON.stringify(error.diagnostic) : String(error));
        process.exitCode = 1;
      }`,
    );
    const sources = new Map(modules.map((module) => [module.file, module.evaluated]));

    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      plugins: [
        typescriptPaths,
        {
          name: "restricted-author-source",
          setup(build) {
            build.onResolve({ filter: /^loopy(?:\/graph)?$/ }, async () => {
              const javascript = resolve(import.meta.dir, "../sdk/graph/index.js");

              return {
                path: (await Bun.file(javascript).exists())
                  ? javascript
                  : javascript.replace(/\.js$/, ".ts"),
              };
            });
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
    });

    const output = result.outputs[0];

    if (!result.success || !output) {
      throw new Error(result.logs.join("\n"));
    }

    const executable = join(scratch, "evaluate.js");
    await writeFile(executable, new Uint8Array(await output.arrayBuffer()));
    const cwd = await realpath(dirname(file));

    const captured = await withBundleSandbox(
      {
        bundle: executable,
        workspace: cwd,
        purpose: "compiler",
        home,
      },
      ({ program, args }) =>
        spawnCaptured(
          { program, args, cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd } },
          { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 * 1024 },
        ),
    );

    if (captured.exitCode !== 0) {
      const reported = reportedDiagnostic(captured.stderr);

      if (reported?.success) {
        throw new EvaluationError(reported.data);
      }

      throw new Error(captured.stderr || "Compiler process failed.");
    }

    // BOUNDARY: The isolated process returns untrusted author-produced graph JSON.
    return graphSchema.parse(JSON.parse(captured.stdout));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
