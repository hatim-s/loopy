import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { type CliContext, requireTarget } from "../context";
import { graphInput } from "../input";
import { printJson } from "../output";

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
