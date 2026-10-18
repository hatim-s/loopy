import { dirname, relative, resolve } from "node:path";
import { compile, formatDiagnostics } from "../../compiler/index.js";
import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { DaemonError } from "../errors.js";
import { printJson } from "../output.js";

export async function runSave(context: CliContext): Promise<void> {
  const source = resolve(context.cwd, requireTarget(context, "TypeScript file"));
  const result = await compile(source, { home: context.home });

  if (!result.ok) {
    throw new DaemonError("bad_request", formatDiagnostics(result.diagnostics));
  }

  const path = relative(context.cwd, source);
  const outside = path === ".." || path.startsWith("../");
  const workspace = !context.values.cwd && outside ? dirname(source) : context.cwd;
  printJson(
    await call(context, routes.putLoopy, {
      params: { slug: result.graph.name },
      query: {},
      body: {
        graph: result.graph,
        revision: result.revision,
        bundles: result.bundles.map((value) => Buffer.from(value.bytes).toString("base64")),
        source: {
          path: source,
          workspace,
        },
        replace: context.values.replace ?? false,
      },
    }),
  );
}
