import { dirname, relative, resolve } from "node:path";
import { compile } from "@loopy/compiler";
import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { type CliContext, requireTarget } from "../context";
import { diagnosticsError } from "../errors";
import { printJson } from "../output";

export function runSave(context: CliContext) {
  return Effect.gen(function* () {
    const source = resolve(context.cwd, yield* requireTarget(context, "TypeScript file"));
    const result = yield* compile(source);

    if (!result.ok) {
      return yield* diagnosticsError(result.diagnostics);
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
