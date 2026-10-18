import { resolve } from "node:path";
import { errorMessage, revision, validateGraph } from "../core/index.js";
import { bundle } from "./bundle.js";
import { evaluate } from "./evaluate.js";
import { restrict } from "./restrict.js";
import type { CompileResult } from "./types.js";

export async function compile(
  path: string,
  options: { home?: string } = {},
): Promise<CompileResult> {
  const file = resolve(path);
  const source = { module: file, line: 1, column: 1 };
  const restricted = await restrict(file);

  if (!restricted.ok) {
    return restricted;
  }

  let evaluated: Awaited<ReturnType<typeof evaluate>>;

  try {
    evaluated = await evaluate(file, restricted.modules, options.home);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{ code: "evaluation_failed", message: errorMessage(error), source }],
    };
  }

  if (!evaluated.ok) {
    return evaluated;
  }

  const { graph } = evaluated;
  const diagnostics = validateGraph(graph);

  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: diagnostics.map((value) => ({
        code: value.code,
        message: value.message,
        source: value.source ?? source,
      })),
    };
  }

  try {
    const bundled = await bundle(graph, restricted.parsers);

    if (!bundled.ok) {
      return bundled;
    }

    return { ok: true, graph, bundles: bundled.bundles, revision: await revision(graph) };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "bundle_failed",
          message:
            error instanceof AggregateError
              ? error.errors.map(errorMessage).join("\n")
              : errorMessage(error),
          source,
        },
      ],
    };
  }
}
