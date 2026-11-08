import { dirname, relative, resolve } from "node:path";
import { compile } from "@loopy/compiler";
import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { diagnosticsError } from "../errors";
import { printJson } from "../output";

export const save = defineCommand({
  path: ["save"],
  summary: "Compile and save a graph",
  options: {
    replace: {
      type: "boolean",
      description: "Replace a saved loopy of the same name that came from another source.",
    },
  },
  positionals: [{ name: "file.ts", label: "TypeScript file" }],
  run: (cli) =>
    Effect.gen(function* () {
      const source = resolve(cli.cwd, cli.args[0]);
      const result = yield* compile(source);

      if (!result.ok) {
        return yield* diagnosticsError(result.diagnostics);
      }

      const path = relative(cli.cwd, source);
      const outside = path === ".." || path.startsWith("../");
      // A file outside an implicit workspace registers beside its source instead.
      const workspace = !cli.cwdExplicit && outside ? dirname(source) : cli.cwd;
      printJson(
        yield* request(cli, routes.putLoopy, {
          params: { slug: result.graph.name },
          body: {
            graph: result.graph,
            revision: result.revision,
            sourceArtifact: result.sourceArtifact,
            bundles: result.bundles,
            source: { path: source, workspace },
            replace: cli.values.replace,
          },
        }),
      );
    }),
});
