import { Effect } from "effect";
import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { graphInput } from "../input.js";
import { printJson } from "../output.js";

export function runRun(context: CliContext) {
  return Effect.gen(function* () {
    const slug = yield* requireTarget(context, "Slug");

    const { graph } = yield* request(
      context,
      `/loopies/${encodeURIComponent(slug)}/graph?workspace=${encodeURIComponent(context.cwd)}`,
      routes.graph.response,
    );

    printJson(
      yield* request(
        context,
        `/loopies/${encodeURIComponent(slug)}/runs`,
        routes.startRun.response,
        {
          method: "POST",
          body: {
            input: yield* graphInput(graph.input, context),
            workspace: context.cwd,
          },
        },
      ),
    );
  });
}
