import { dirname, relative, resolve } from "node:path";
import { Effect } from "effect";
import { compile } from "../../compiler/index.js";
import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { diagnosticsError } from "../errors.js";
import { printJson } from "../output.js";

export function runSave(context: CliContext) {
  return Effect.gen(function* () {
    const source = resolve(context.cwd, yield* requireTarget(context, "TypeScript file"));
    const result = yield* compile(source);

    if (!result.ok) {
      return yield* Effect.fail(diagnosticsError(result.diagnostics));
    }

    const path = relative(context.cwd, source);
    const outside = path === ".." || path.startsWith("../");
    const workspace = !context.values.cwd && outside ? dirname(source) : context.cwd;
    printJson(
      yield* request(
        context,
        `/loopies/${encodeURIComponent(result.graph.name)}`,
        routes.putLoopy.response,
        {
          method: "PUT",
          body: {
            graph: result.graph,
            revision: result.revision,
            sourceArtifact: result.sourceArtifact,
            bundles: result.bundles.map((value) => ({
              ...value,
              bytes: Buffer.from(value.bytes).toString("base64"),
            })),
            source: {
              path: source,
              workspace,
            },
            replace: context.values.replace ?? false,
          },
        },
      ),
    );
  });
}
