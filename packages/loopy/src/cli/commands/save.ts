import { dirname, relative, resolve } from "node:path";
import { compile } from "../../compiler/index.js";
import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export async function runSave(context: CliContext): Promise<void> {
  const source = resolve(context.cwd, requireTarget(context, "TypeScript file"));
  const result = await compile(source);

  if (!result.ok) {
    throw new Error(
      result.diagnostics
        .map(
          (value) => `${value.file}:${value.line}:${value.column} [${value.code}] ${value.message}`,
        )
        .join("\n"),
    );
  }

  const path = relative(context.cwd, source);
  const outside = path === ".." || path.startsWith("../");
  const workspace = !context.values.cwd && outside ? dirname(source) : context.cwd;
  printJson(
    await request(
      context,
      `/loopies/${encodeURIComponent(result.graph.name)}`,
      routes.putLoopy.response,
      {
        method: "PUT",
        body: {
          graph: result.graph,
          revision: result.revision,
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
}
