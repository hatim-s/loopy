import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { graphInput } from "../input.js";
import { printJson } from "../output.js";

export async function runRun(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");

  const graph = await call(context, routes.graph, {
    params: { slug },
    query: { workspace: context.cwd },
    body: undefined,
  });

  printJson(
    await call(context, routes.startRun, {
      params: { slug },
      query: {},
      body: { input: await graphInput(graph.input, context), workspace: context.cwd },
    }),
  );
}
