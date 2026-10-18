import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { graphInput } from "../input.js";
import { printJson } from "../output.js";

export async function runRun(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");

  const graph = await request(
    context,
    `/loopies/${encodeURIComponent(slug)}/graph?workspace=${encodeURIComponent(context.cwd)}`,
    routes.graph.response,
  );

  printJson(
    await request(context, `/loopies/${encodeURIComponent(slug)}/runs`, routes.startRun.response, {
      method: "POST",
      body: { input: await graphInput(graph.input, context), workspace: context.cwd },
    }),
  );
}
