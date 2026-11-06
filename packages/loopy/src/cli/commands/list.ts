import { Effect } from "effect";
import { routes } from "../../contract";
import { request } from "../client";
import { type CliContext, expectNoArguments } from "../context";
import { printJson } from "../output";

export function runList(context: CliContext) {
  return Effect.gen(function* () {
    yield* expectNoArguments(context);
    printJson(
      yield* request(
        context,
        `/loopies?workspace=${encodeURIComponent(context.cwd)}`,
        routes.loopies.response,
      ),
    );
  });
}
