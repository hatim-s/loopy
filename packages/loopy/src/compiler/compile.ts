import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CompilerDiagnosticCode,
  errorMessage,
  revision,
  validateGraph,
} from "../core/index.js";
import { bundle } from "./bundle.js";
import { EvaluationError, evaluate } from "./evaluate.js";
import { restrict } from "./restrict.js";
import type { CompileResult } from "./types.js";

export async function compile(
  path: string,
  options: { home?: string } = {},
): Promise<CompileResult> {
  const file = resolve(path);
  let stage: CompilerDiagnosticCode = "source_error";

  try {
    const restricted = await restrict(await realpath(file));

    if (!restricted.ok) {
      return restricted;
    }

    stage = "evaluation_failed";
    const graph = await evaluate(await realpath(file), restricted.modules, options.home);
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
      };
    }

    stage = "bundle_failed";
    const bundled = await bundle(graph, restricted.parsers);

    if (!bundled.ok) {
      return bundled;
    }

    return {
      ok: true,
      graph,
      bundles: bundled.bundles,
      revision: await revision(graph),
    };
  } catch (error) {
    if (error instanceof EvaluationError) {
      const value = error.diagnostic;

      return {
        ok: false,
        diagnostics: [
          {
            code: value.code,
            message: value.message,
            file: value.source?.module ?? file,
            line: value.source?.line ?? 1,
            column: value.source?.column ?? 1,
          },
        ],
      };
    }

    return {
      ok: false,
      diagnostics: [
        {
          code: stage,
          message:
            error instanceof AggregateError
              ? error.errors.map(errorMessage).join("\n")
              : errorMessage(error),
          file,
          line: 1,
          column: 1,
        },
      ],
    };
  }
}
